"""Figures for the study PDFs, drawn from a JSON description by the engine's own code.

Claude used to write a matplotlib script for each figure, and the engine ran it. A script is a program, and Claude
writes it after reading class material that anyone who can post in the class can put words into, so no checker of the
script's text can make running it safe. Now Claude writes only data: which curves, points, shapes, arrows and labels
to draw. This module checks every field against a fixed schema and draws it; nothing in a spec is ever run, imported
or used as a file path (formulas are read by a small evaluator that only knows arithmetic and a list of math
functions), and the only files written are the named images in the spec's own img/ folder.

The schema (every field is optional unless marked):

    {"figures": [figure, ...]}            or a single figure object
    figure: {"file": "name.png" (required; lowercase letters, digits, '-' and '_'; .png or .svg),
             "size": [w, h] inches, "layout": [rows, cols], "title": str,
             "panels": [panel, ...]  (or the panel's own fields directly on the figure)}
    panel:  {"title", "xlabel", "ylabel": str, "xlim", "ylim": [lo, hi], "xscale", "yscale": "linear" | "log",
             "aspect": "equal" | "auto", "grid": bool, "frame": "open" | "box" | "cross" | "off",
             "xticks", "yticks": [numbers] | {"at": [numbers], "labels": [str]}, "legend": bool | location,
             "font": size, "items": [item, ...]}
    item:   {"type": one of ITEM_TYPES, ...} (see _draw_* below for each type's fields)

Formulas ("expr", "x", "y", "expr2", and string values in "vars") use x (or t for a parametric curve), numbers, the
spec's own "vars", pi and e, + - * / ** %, comparisons, and these functions: see FUNCTIONS.
"""

from __future__ import annotations

import ast
import json
import math
import re
from pathlib import Path
from typing import Any

import numpy as np

MAX_SPEC_BYTES = 512 * 1024
MAX_FIGURES = 12
MAX_PANELS = 9
MAX_ITEMS = 300
MAX_POINTS = 5000
MAX_SAMPLES = 4000
MAX_GRID = 600  # implicit curves: samples per axis
MAX_TEXT = 400
MAX_EXPR = 400
MAX_EXPR_NODES = 200
FILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,59}\.(png|svg)$")
VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,15}$")

FUNCTIONS: dict[str, Any] = {
    "sin": np.sin, "cos": np.cos, "tan": np.tan, "asin": np.arcsin, "acos": np.arccos, "atan": np.arctan,
    "arcsin": np.arcsin, "arccos": np.arccos, "arctan": np.arctan, "atan2": np.arctan2, "arctan2": np.arctan2,
    "sinh": np.sinh, "cosh": np.cosh, "tanh": np.tanh, "exp": np.exp, "log": np.log, "ln": np.log,
    "log10": np.log10, "log2": np.log2, "sqrt": np.sqrt, "cbrt": np.cbrt, "abs": np.abs, "floor": np.floor,
    "ceil": np.ceil, "round": np.round, "sign": np.sign, "min": np.minimum, "max": np.maximum,
    "minimum": np.minimum, "maximum": np.maximum, "where": np.where, "clip": np.clip, "hypot": np.hypot,
}
CONSTANTS = {"pi": math.pi, "e": math.e}
_BINOPS = {ast.Add: np.add, ast.Sub: np.subtract, ast.Mult: np.multiply, ast.Div: np.true_divide,
           ast.Pow: np.power, ast.Mod: np.mod}
_CMPOPS = {ast.Lt: np.less, ast.LtE: np.less_equal, ast.Gt: np.greater, ast.GtE: np.greater_equal,
           ast.Eq: np.equal, ast.NotEq: np.not_equal}

LINESTYLES = {"-": "-", "--": "--", ":": ":", "-.": "-.", "solid": "-", "dashed": "--", "dotted": ":",
              "dashdot": "-."}
MARKERS = {"o", "s", "^", "v", "<", ">", "D", "d", "x", "+", "*", ".", "p", "h", "P", "X"}
ARROWS = {"->", "<-", "<->", "-|>", "<|-", "<|-|>", "-", "fancy", "simple", "wedge"}
LEGEND_LOCS = {"best", "upper right", "upper left", "lower left", "lower right", "right", "center left",
               "center right", "lower center", "upper center", "center"}
CMAPS = {"viridis", "plasma", "inferno", "magma", "cividis", "Greys", "Blues", "Greens", "Reds", "Oranges",
         "Purples", "RdYlGn", "RdYlBu", "RdBu", "coolwarm", "Spectral", "PiYG", "BrBG", "YlOrRd", "YlGnBu",
         "rainbow", "turbo", "jet"}
ITEM_TYPES = ("function", "parametric", "implicit", "line", "scatter", "point", "bar", "fill", "hline", "vline",
              "hspan", "vspan", "segment", "arrow", "text", "rect", "circle", "ellipse", "polygon", "gradient")


class SpecError(ValueError):
    """A spec that doesn't follow the schema (the message says where)."""


# ---------- Reading values ----------
def _num(v: Any, where: str, lo: float = -1e9, hi: float = 1e9) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise SpecError(f"{where}: expected a number")
    if not lo <= v <= hi:
        raise SpecError(f"{where}: {v} is outside {lo}..{hi}")
    return float(v)


def _int(v: Any, where: str, lo: int, hi: int) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise SpecError(f"{where}: expected a whole number {lo}..{hi}")
    return v


def _str(v: Any, where: str, limit: int = MAX_TEXT) -> str:
    if not isinstance(v, str):
        raise SpecError(f"{where}: expected text")
    if len(v) > limit:
        raise SpecError(f"{where}: longer than {limit} characters")
    return v


def _choice(v: Any, where: str, options: set[str] | dict[str, str] | tuple[str, ...]) -> str:
    if not isinstance(v, str) or v not in options:
        raise SpecError(f"{where}: expected one of {', '.join(sorted(options))}")
    return options[v] if isinstance(options, dict) else v


def _pair(v: Any, where: str) -> tuple[float, float]:
    if not isinstance(v, list) or len(v) != 2:
        raise SpecError(f"{where}: expected [a, b]")
    return _num(v[0], f"{where}[0]"), _num(v[1], f"{where}[1]")


def _range(v: Any, where: str) -> tuple[float, float]:
    a, b = _pair(v, where)
    if a == b:
        raise SpecError(f"{where}: the two ends are the same")
    return a, b


def _numbers(v: Any, where: str, limit: int = MAX_POINTS) -> list[float]:
    if not isinstance(v, list):
        raise SpecError(f"{where}: expected a list of numbers")
    if len(v) > limit:
        raise SpecError(f"{where}: more than {limit} values")
    return [_num(x, f"{where}[{i}]") for i, x in enumerate(v)]


def _points(v: Any, where: str, limit: int = MAX_POINTS) -> list[tuple[float, float]]:
    if not isinstance(v, list) or len(v) > limit:
        raise SpecError(f"{where}: expected a list of [x, y] (at most {limit})")
    return [_pair(p, f"{where}[{i}]") for i, p in enumerate(v)]


def _color(v: Any, where: str) -> str:
    from matplotlib.colors import is_color_like

    if not isinstance(v, str) or len(v) > 30 or not is_color_like(v):
        raise SpecError(f"{where}: not a color (a name like 'navy' or '#1f3a5f')")
    return v


def _known(obj: dict, where: str, allowed: set[str]) -> None:
    extra = set(obj) - allowed
    if extra:
        raise SpecError(f"{where}: unknown field(s) {', '.join(sorted(extra))}")


# ---------- Formulas ----------
def parse_expr(src: Any, where: str, names: set[str]) -> ast.Expression:
    """A formula's syntax tree, after checking it only uses arithmetic, comparisons, known names and FUNCTIONS."""
    if not isinstance(src, str) or not src.strip():
        raise SpecError(f"{where}: expected a formula")
    if len(src) > MAX_EXPR:
        raise SpecError(f"{where}: formula longer than {MAX_EXPR} characters")
    try:
        tree = ast.parse(src.replace("^", "**"), mode="eval")
    except SyntaxError as err:
        raise SpecError(f"{where}: the formula doesn't parse ({err.msg})") from None
    count = 0
    for node in ast.walk(tree):
        count += 1
        if count > MAX_EXPR_NODES:
            raise SpecError(f"{where}: formula too long")
        if isinstance(node, (ast.Expression, ast.Load)) or type(node) in _BINOPS or type(node) in _CMPOPS:
            continue
        if isinstance(node, (ast.USub, ast.UAdd)):
            continue
        if isinstance(node, ast.BinOp):
            if type(node.op) not in _BINOPS:
                raise SpecError(f"{where}: operator not allowed")
        elif isinstance(node, ast.UnaryOp):
            if not isinstance(node.op, (ast.USub, ast.UAdd)):
                raise SpecError(f"{where}: operator not allowed")
        elif isinstance(node, ast.Compare):
            if any(type(op) not in _CMPOPS for op in node.ops):
                raise SpecError(f"{where}: comparison not allowed")
        elif isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise SpecError(f"{where}: only numbers can appear in a formula")
        elif isinstance(node, ast.Name):
            if node.id not in names and node.id not in CONSTANTS and node.id not in FUNCTIONS:
                raise SpecError(f"{where}: unknown name {node.id!r}")
        elif isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in FUNCTIONS or node.keywords:
                raise SpecError(f"{where}: only these functions can be called: {', '.join(sorted(FUNCTIONS))}")
            if len(node.args) > 3:
                raise SpecError(f"{where}: too many arguments to {node.func.id}")
        else:
            raise SpecError(f"{where}: {type(node).__name__} isn't allowed in a formula")
    return tree


def _eval(node: ast.AST, env: dict[str, Any]) -> Any:
    if isinstance(node, ast.Expression):
        return _eval(node.body, env)
    if isinstance(node, ast.Constant):
        return np.float64(node.value)  # (floats only: 9**9**9 overflows to inf instead of running forever)
    if isinstance(node, ast.Name):
        if node.id in env:
            return env[node.id]
        if node.id in CONSTANTS:
            return np.float64(CONSTANTS[node.id])
        raise SpecError(f"{node.id} is a function: call it, like {node.id}(x)")
    if isinstance(node, ast.BinOp):
        return _BINOPS[type(node.op)](_eval(node.left, env), _eval(node.right, env))
    if isinstance(node, ast.UnaryOp):
        v = _eval(node.operand, env)
        return -v if isinstance(node.op, ast.USub) else v
    if isinstance(node, ast.Compare):
        left = _eval(node.left, env)
        out = None
        for op, right_node in zip(node.ops, node.comparators, strict=True):
            right = _eval(right_node, env)
            r = _CMPOPS[type(op)](left, right)
            out = r if out is None else np.logical_and(out, r)
            left = right
        return out
    if isinstance(node, ast.Call):
        assert isinstance(node.func, ast.Name)
        return FUNCTIONS[node.func.id](*(_eval(a, env) for a in node.args))
    raise SpecError(f"{type(node).__name__} isn't allowed in a formula")  # (parse_expr already refused it)


def _vars(item: dict, where: str, free: set[str]) -> list[tuple[str, Any]]:
    """The item's "vars": numbers, or formulas using the free variable(s) and the vars before them."""
    raw = item.get("vars", {})
    if not isinstance(raw, dict) or len(raw) > 30:
        raise SpecError(f"{where}.vars: expected an object of at most 30 names")
    out: list[tuple[str, Any]] = []
    names = set(free)
    for k, v in raw.items():
        if not VAR_RE.fullmatch(k) or k in FUNCTIONS or k in CONSTANTS or k in free:
            raise SpecError(f"{where}.vars: {k!r} can't be a name")
        if isinstance(v, str):
            out.append((k, parse_expr(v, f"{where}.vars.{k}", names)))
        else:
            out.append((k, _num(v, f"{where}.vars.{k}")))
        names.add(k)
    return out


def evaluate(src: str, where: str, free: dict[str, np.ndarray], var_list: list[tuple[str, Any]]) -> np.ndarray:
    """A formula's values over the free variable(s): infinities become gaps (NaN), like a graph's asymptotes."""
    tree = parse_expr(src, where, set(free) | {k for k, _ in var_list})
    env: dict[str, Any] = dict(free)
    with np.errstate(all="ignore"):
        for k, v in var_list:
            env[k] = _eval(v, env) if isinstance(v, ast.AST) else np.float64(v)
        try:
            out = _eval(tree, env)
        except (TypeError, ValueError) as err:
            raise SpecError(f"{where}: {err}") from None
        shape = next(iter(free.values())).shape
        out = np.broadcast_to(np.asarray(out, dtype=float), shape).copy()
    out[~np.isfinite(out)] = np.nan
    return out


# ---------- Drawing ----------
def _style(item: dict, where: str) -> dict[str, Any]:
    kw: dict[str, Any] = {}
    if "color" in item:
        kw["color"] = _color(item["color"], f"{where}.color")
    if "width" in item:
        kw["linewidth"] = _num(item["width"], f"{where}.width", 0.1, 12)
    if "style" in item:
        kw["linestyle"] = _choice(item["style"], f"{where}.style", LINESTYLES)
    if "alpha" in item:
        kw["alpha"] = _num(item["alpha"], f"{where}.alpha", 0, 1)
    if "label" in item:
        kw["label"] = _str(item["label"], f"{where}.label", 200)
    if "z" in item:
        kw["zorder"] = _num(item["z"], f"{where}.z", -10, 50)
    return kw


COMMON = {"type", "color", "width", "style", "alpha", "label", "z"}


def _samples(item: dict, where: str, default: int = 400) -> int:
    return _int(item.get("points", default), f"{where}.points", 2, MAX_SAMPLES)


def _draw_function(ax, item, where):
    """{"expr": "f(x)", "domain": [a, b], "vars": {...}, "points": n}"""
    _known(item, where, COMMON | {"expr", "domain", "vars", "points"})
    a, b = _range(item.get("domain"), f"{where}.domain")
    x = np.linspace(a, b, _samples(item, where))
    y = evaluate(item.get("expr"), f"{where}.expr", {"x": x}, _vars(item, where, {"x"}))
    ax.plot(x, y, **_style(item, where))


def _draw_parametric(ax, item, where):
    """{"x": "x(t)", "y": "y(t)", "t": [a, b], "vars": {...}, "points": n}"""
    _known(item, where, COMMON | {"x", "y", "t", "vars", "points"})
    a, b = _range(item.get("t"), f"{where}.t")
    t = np.linspace(a, b, _samples(item, where))
    v = _vars(item, where, {"t"})
    ax.plot(evaluate(item.get("x"), f"{where}.x", {"t": t}, v), evaluate(item.get("y"), f"{where}.y", {"t": t}, v),
            **_style(item, where))


def _draw_implicit(ax, item, where):
    """The curve where a formula in x and y is 0: {"expr": "x**2/9 - y**2/4 - 1", "x": [a, b], "y": [c, d]}"""
    _known(item, where, COMMON | {"expr", "x", "y", "vars", "points"})
    n = _int(item.get("points", 400), f"{where}.points", 20, MAX_GRID)
    xs = np.linspace(*_range(item.get("x"), f"{where}.x"), n)
    ys = np.linspace(*_range(item.get("y"), f"{where}.y"), n)
    gx, gy = np.meshgrid(xs, ys)
    z = evaluate(item.get("expr"), f"{where}.expr", {"x": gx, "y": gy}, _vars(item, where, {"x", "y"}))
    kw = _style(item, where)
    label = kw.pop("label", None)
    ax.contour(gx, gy, z, levels=[0], colors=[kw.pop("color", "#1f3a5f")],
               linewidths=[kw.pop("linewidth", 1.8)], linestyles=[kw.pop("linestyle", "-")], **kw)
    if label:
        ax.plot([], [], color=item.get("color", "#1f3a5f"), label=label)


def _xy(item, where):
    if "points" in item:
        pts = _points(item["points"], f"{where}.points")
        return [p[0] for p in pts], [p[1] for p in pts]
    xs, ys = _numbers(item.get("x"), f"{where}.x"), _numbers(item.get("y"), f"{where}.y")
    if len(xs) != len(ys):
        raise SpecError(f"{where}: x and y have different lengths")
    return xs, ys


def _draw_line(ax, item, where):
    """Data joined by lines: {"x": [...], "y": [...]} or {"points": [[x, y], ...]}; "marker" optional."""
    _known(item, where, COMMON | {"x", "y", "points", "marker", "size"})
    xs, ys = _xy(item, where)
    kw = _style(item, where)
    if "marker" in item:
        kw["marker"] = _choice(item["marker"], f"{where}.marker", MARKERS)
        kw["markersize"] = _num(item.get("size", 5), f"{where}.size", 1, 30)
    ax.plot(xs, ys, **kw)


def _draw_scatter(ax, item, where):
    """Data points: {"x": [...], "y": [...]} or {"points": [...]}, "marker", "size", "edge", "filled"."""
    _known(item, where, COMMON | {"x", "y", "points", "marker", "size", "edge", "filled"})
    xs, ys = _xy(item, where)
    kw = _style(item, where)
    kw.pop("linestyle", None)
    lw = kw.pop("linewidth", None)
    color = kw.pop("color", "#1f3a5f")
    filled = item.get("filled", True) is not False
    ax.scatter(xs, ys, marker=_choice(item.get("marker", "o"), f"{where}.marker", MARKERS),
               s=_num(item.get("size", 30), f"{where}.size", 1, 600),
               c=color if filled else "none",
               edgecolors=_color(item["edge"], f"{where}.edge") if "edge" in item else color,
               linewidths=lw if lw is not None else 1.0, **kw)


def _draw_point(ax, item, where):
    """One marked point with an optional label: {"at": [x, y], "text": "...", "offset": [dx, dy] (points)}"""
    _known(item, where, COMMON | {"at", "text", "offset", "marker", "size", "fontsize", "ha", "va"})
    x, y = _pair(item.get("at"), f"{where}.at")
    kw = _style(item, where)
    kw.pop("linestyle", None)
    kw.pop("linewidth", None)
    color = kw.pop("color", "#9b2c2c")
    ax.plot([x], [y], linestyle="none", marker=_choice(item.get("marker", "o"), f"{where}.marker", MARKERS),
            markersize=_num(item.get("size", 6), f"{where}.size", 1, 30), color=color, **kw)
    if "text" in item:
        dx, dy = _pair(item.get("offset", [6, 6]), f"{where}.offset")
        ax.annotate(_str(item["text"], f"{where}.text"), xy=(x, y), xytext=(dx, dy), textcoords="offset points",
                    color=color, fontsize=_num(item.get("fontsize", 10), f"{where}.fontsize", 4, 40),
                    ha=_choice(item.get("ha", "left"), f"{where}.ha", {"left", "center", "right"}),
                    va=_choice(item.get("va", "bottom"), f"{where}.va", {"top", "center", "bottom", "baseline"}))


def _draw_bar(ax, item, where):
    """Bars: {"labels": [...] or "x": [numbers], "values": [...], "horizontal": bool, "base": [...], "barwidth": n,
    "colors": [...], "edge": color}"""
    _known(item, where, COMMON | {"labels", "x", "values", "horizontal", "base", "barwidth", "colors", "edge"})
    values = _numbers(item.get("values"), f"{where}.values", 200)
    if "labels" in item:
        if not isinstance(item["labels"], list) or len(item["labels"]) != len(values):
            raise SpecError(f"{where}.labels: one label per value")
        pos: list[Any] = [_str(s, f"{where}.labels[{i}]", 80) for i, s in enumerate(item["labels"])]
    else:
        pos = _numbers(item.get("x", list(range(len(values)))), f"{where}.x", 200)
        if len(pos) != len(values):
            raise SpecError(f"{where}.x: one position per value")
    base = _numbers(item["base"], f"{where}.base", 200) if "base" in item else None
    if base is not None and len(base) != len(values):
        raise SpecError(f"{where}.base: one per value")
    kw = _style(item, where)
    kw.pop("linestyle", None)
    lw = kw.pop("linewidth", None)
    if "colors" in item:
        if not isinstance(item["colors"], list) or len(item["colors"]) != len(values):
            raise SpecError(f"{where}.colors: one color per value")
        kw["color"] = [_color(c, f"{where}.colors[{i}]") for i, c in enumerate(item["colors"])]
    if "edge" in item:
        kw["edgecolor"] = _color(item["edge"], f"{where}.edge")
        kw["linewidth"] = lw if lw is not None else 1.0
    size = _num(item.get("barwidth", 0.8), f"{where}.barwidth", 0.01, 1e6)
    if item.get("horizontal") is True:
        ax.barh(pos, values, height=size, left=base, **kw)
    else:
        ax.bar(pos, values, width=size, bottom=base, **kw)


def _draw_fill(ax, item, where):
    """Shade between two curves: {"expr": "f(x)", "expr2": "g(x)" (default 0), "domain": [a, b], "where": "cond"}
    or data {"x": [...], "y": [...], "y2": [...]}."""
    _known(item, where, COMMON | {"expr", "expr2", "domain", "vars", "points", "x", "y", "y2", "where"})
    kw = _style(item, where)
    kw.pop("linestyle", None)
    kw.pop("linewidth", None)
    kw.setdefault("alpha", 0.25)
    if "expr" in item:
        a, b = _range(item.get("domain"), f"{where}.domain")
        x = np.linspace(a, b, _samples(item, where))
        v = _vars(item, where, {"x"})
        y1 = evaluate(item["expr"], f"{where}.expr", {"x": x}, v)
        y2 = evaluate(item.get("expr2", "0"), f"{where}.expr2", {"x": x}, v)
        mask = evaluate(item["where"], f"{where}.where", {"x": x}, v) > 0 if "where" in item else None
        ax.fill_between(x, y1, y2, where=mask, linewidth=0, **kw)
    else:
        xs, ys = _xy(item, where)
        y2: Any = _numbers(item["y2"], f"{where}.y2") if "y2" in item else 0
        if isinstance(y2, list) and len(y2) != len(xs):
            raise SpecError(f"{where}.y2: one per x")
        ax.fill_between(xs, ys, y2, linewidth=0, **kw)


def _draw_hline(ax, item, where):
    """{"y": n, "from": x0, "to": x1} (without from/to it spans the panel)"""
    _known(item, where, COMMON | {"y", "from", "to"})
    y = _num(item.get("y"), f"{where}.y")
    kw = {"color": "gray", "linewidth": 1.0, **_style(item, where)}
    if "from" in item or "to" in item:
        ax.hlines(y, _num(item.get("from"), f"{where}.from"), _num(item.get("to"), f"{where}.to"),
                  colors=kw.pop("color"), linewidths=kw.pop("linewidth"), linestyles=kw.pop("linestyle", "-"), **kw)
    else:
        ax.axhline(y, **kw)


def _draw_vline(ax, item, where):
    """{"x": n, "from": y0, "to": y1}"""
    _known(item, where, COMMON | {"x", "from", "to"})
    x = _num(item.get("x"), f"{where}.x")
    kw = {"color": "gray", "linewidth": 1.0, **_style(item, where)}
    if "from" in item or "to" in item:
        ax.vlines(x, _num(item.get("from"), f"{where}.from"), _num(item.get("to"), f"{where}.to"),
                  colors=kw.pop("color"), linewidths=kw.pop("linewidth"), linestyles=kw.pop("linestyle", "-"), **kw)
    else:
        ax.axvline(x, **kw)


def _draw_hspan(ax, item, where):
    """A shaded horizontal band: {"from": y0, "to": y1}"""
    _known(item, where, COMMON | {"from", "to"})
    kw = {"alpha": 0.15, **_style(item, where)}
    kw.pop("linestyle", None)
    kw.pop("linewidth", None)
    ax.axhspan(_num(item.get("from"), f"{where}.from"), _num(item.get("to"), f"{where}.to"), linewidth=0, **kw)


def _draw_vspan(ax, item, where):
    """A shaded vertical band: {"from": x0, "to": x1}"""
    _known(item, where, COMMON | {"from", "to"})
    kw = {"alpha": 0.15, **_style(item, where)}
    kw.pop("linestyle", None)
    kw.pop("linewidth", None)
    ax.axvspan(_num(item.get("from"), f"{where}.from"), _num(item.get("to"), f"{where}.to"), linewidth=0, **kw)


def _draw_segment(ax, item, where):
    """A straight line between two points: {"from": [x, y], "to": [x, y]}"""
    _known(item, where, COMMON | {"from", "to"})
    (x0, y0), (x1, y1) = _pair(item.get("from"), f"{where}.from"), _pair(item.get("to"), f"{where}.to")
    ax.plot([x0, x1], [y0, y1], **{"color": "#1f3a5f", **_style(item, where)})


def _draw_arrow(ax, item, where):
    """An arrow from one point to another, with optional text at its tail: {"from": [x, y], "to": [x, y],
    "text": "...", "head": "->" | "<->" | ..., "fontsize": n, "curve": -1..1}"""
    _known(item, where, COMMON | {"from", "to", "text", "head", "fontsize", "curve", "ha", "va"})
    tail, tip = _pair(item.get("from"), f"{where}.from"), _pair(item.get("to"), f"{where}.to")
    kw = _style(item, where)
    color = kw.pop("color", "#1f3a5f")
    props: dict[str, Any] = {"arrowstyle": _choice(item.get("head", "->"), f"{where}.head", ARROWS), "color": color,
                             "lw": kw.pop("linewidth", 1.4)}
    if "linestyle" in kw:
        props["linestyle"] = kw.pop("linestyle")
    if "curve" in item:
        props["connectionstyle"] = f"arc3,rad={_num(item['curve'], f'{where}.curve', -1, 1)}"
    kw.pop("label", None)
    ax.annotate(_str(item.get("text", ""), f"{where}.text"), xy=tip, xytext=tail, arrowprops=props, color=color,
                fontsize=_num(item.get("fontsize", 10), f"{where}.fontsize", 4, 40),
                ha=_choice(item.get("ha", "center"), f"{where}.ha", {"left", "center", "right"}),
                va=_choice(item.get("va", "center"), f"{where}.va", {"top", "center", "bottom", "baseline"}), **kw)


def _draw_text(ax, item, where):
    """{"at": [x, y], "text": "...", "size": n, "ha", "va", "rotation", "bold", "italic", "box": bool | color,
    "coords": "data" | "axes" (0-1 across the panel)}. Math in $...$ (matplotlib's mathtext)."""
    _known(item, where, COMMON | {"at", "text", "size", "ha", "va", "rotation", "bold", "italic", "box", "coords"})
    x, y = _pair(item.get("at"), f"{where}.at")
    kw = _style(item, where)
    kw.pop("linestyle", None)
    kw.pop("linewidth", None)
    kw.pop("label", None)
    if item.get("box"):
        face = _color(item["box"], f"{where}.box") if isinstance(item["box"], str) else "white"
        kw["bbox"] = {"boxstyle": "round,pad=0.3", "facecolor": face, "edgecolor": "#999999", "linewidth": 0.6}
    if _choice(item.get("coords", "data"), f"{where}.coords", {"data", "axes"}) == "axes":
        kw["transform"] = ax.transAxes
    ax.text(x, y, _str(item.get("text"), f"{where}.text"), fontsize=_num(item.get("size", 10), f"{where}.size", 4, 40),
            ha=_choice(item.get("ha", "left"), f"{where}.ha", {"left", "center", "right"}),
            va=_choice(item.get("va", "baseline"), f"{where}.va", {"top", "center", "bottom", "baseline"}),
            rotation=_num(item.get("rotation", 0), f"{where}.rotation", -360, 360),
            fontweight="bold" if item.get("bold") is True else "normal",
            fontstyle="italic" if item.get("italic") is True else "normal", **kw)


def _patch_style(item, where, default_fill="none"):
    kw = _style(item, where)
    out: dict[str, Any] = {"facecolor": _color(item["fill"], f"{where}.fill") if "fill" in item else default_fill,
                           "edgecolor": kw.pop("color", "#1f3a5f"), "linewidth": kw.pop("linewidth", 1.4)}
    out.update(kw)
    return out


def _label_inside(ax, item, where, x, y):
    if "text" in item:
        ax.text(x, y, _str(item["text"], f"{where}.text"), ha="center", va="center",
                fontsize=_num(item.get("fontsize", 10), f"{where}.fontsize", 4, 40),
                color=_color(item["textcolor"], f"{where}.textcolor") if "textcolor" in item else "black")


PATCH = COMMON | {"fill", "text", "fontsize", "textcolor"}


def _draw_rect(ax, item, where):
    """{"at": [x, y] (lower left), "width", "height", "fill": color, "color": edge, "rounded": bool, "text": "..."}"""
    from matplotlib.patches import FancyBboxPatch, Rectangle

    _known(item, where, PATCH | {"at", "width", "height", "rounded"})
    x, y = _pair(item.get("at"), f"{where}.at")
    w, h = _num(item.get("width"), f"{where}.width", 0, 1e9), _num(item.get("height"), f"{where}.height", 0, 1e9)
    kw = _patch_style(item, where)
    if item.get("rounded") is True:
        pad = min(w, h) * 0.08
        ax.add_patch(FancyBboxPatch((x + pad, y + pad), max(w - 2 * pad, 0), max(h - 2 * pad, 0),
                                    boxstyle=f"round,pad={pad}", **kw))
    else:
        ax.add_patch(Rectangle((x, y), w, h, **kw))
    _label_inside(ax, item, where, x + w / 2, y + h / 2)


def _draw_circle(ax, item, where):
    """{"center": [x, y], "radius": r, "fill", "color", "text"}"""
    from matplotlib.patches import Circle

    _known(item, where, PATCH | {"center", "radius"})
    c = _pair(item.get("center"), f"{where}.center")
    ax.add_patch(Circle(c, _num(item.get("radius"), f"{where}.radius", 0, 1e9), **_patch_style(item, where)))
    _label_inside(ax, item, where, *c)


def _draw_ellipse(ax, item, where):
    """{"center": [x, y], "width", "height", "angle": degrees, "fill", "color", "text"}"""
    from matplotlib.patches import Ellipse

    _known(item, where, PATCH | {"center", "width", "height", "angle"})
    c = _pair(item.get("center"), f"{where}.center")
    ax.add_patch(Ellipse(c, _num(item.get("width"), f"{where}.width", 0, 1e9),
                         _num(item.get("height"), f"{where}.height", 0, 1e9),
                         angle=_num(item.get("angle", 0), f"{where}.angle", -360, 360), **_patch_style(item, where)))
    _label_inside(ax, item, where, *c)


def _draw_polygon(ax, item, where):
    """{"points": [[x, y], ...], "closed": bool (default true), "fill", "color"}"""
    from matplotlib.patches import Polygon

    _known(item, where, PATCH | {"points", "closed"})
    pts = _points(item.get("points"), f"{where}.points", 500)
    if len(pts) < 2:
        raise SpecError(f"{where}.points: at least two")
    ax.add_patch(Polygon(pts, closed=item.get("closed", True) is not False, **_patch_style(item, where)))
    if "text" in item:
        _label_inside(ax, item, where, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def _draw_gradient(ax, item, where):
    """A color scale (the pH scale, a spectrum): {"extent": [x0, x1, y0, y1], "colors": [...] or "cmap": name,
    "direction": "x" | "y"}"""
    from matplotlib.colors import LinearSegmentedColormap

    _known(item, where, {"type", "extent", "colors", "cmap", "direction", "alpha", "z"})
    ext = item.get("extent")
    if not isinstance(ext, list) or len(ext) != 4:
        raise SpecError(f"{where}.extent: expected [x0, x1, y0, y1]")
    extent = [_num(v, f"{where}.extent[{i}]") for i, v in enumerate(ext)]
    if "colors" in item:
        cols = item["colors"]
        if not isinstance(cols, list) or not 2 <= len(cols) <= 16:
            raise SpecError(f"{where}.colors: 2 to 16 colors")
        cmap: Any = LinearSegmentedColormap.from_list("spec", [_color(c, f"{where}.colors[{i}]") for i, c in enumerate(cols)])
    else:
        cmap = _choice(item.get("cmap", "viridis"), f"{where}.cmap", CMAPS)
    ramp = np.linspace(0, 1, 256)
    data = ramp[np.newaxis, :] if item.get("direction", "x") == "x" else ramp[:, np.newaxis]
    ax.imshow(data, extent=extent, origin="lower", aspect="auto", cmap=cmap,
              alpha=_num(item.get("alpha", 1), f"{where}.alpha", 0, 1),
              zorder=_num(item.get("z", 0), f"{where}.z", -10, 50))


DRAW = {name: globals()[f"_draw_{name}"] for name in ITEM_TYPES}
PANEL_FIELDS = {"title", "xlabel", "ylabel", "xlim", "ylim", "xscale", "yscale", "aspect", "grid", "frame", "xticks",
                "yticks", "legend", "font", "items"}
FIGURE_FIELDS = {"file", "size", "layout", "title", "panels"}


def _ticks(ax, axis: str, v: Any, where: str) -> None:
    set_ticks = ax.set_xticks if axis == "x" else ax.set_yticks
    set_labels = ax.set_xticklabels if axis == "x" else ax.set_yticklabels
    if isinstance(v, list):
        set_ticks(_numbers(v, where, 100))
    elif isinstance(v, dict):
        _known(v, where, {"at", "labels"})
        at = _numbers(v.get("at"), f"{where}.at", 100)
        labels = v.get("labels")
        if not isinstance(labels, list) or len(labels) != len(at):
            raise SpecError(f"{where}.labels: one label per tick")
        set_ticks(at)
        set_labels([_str(s, f"{where}.labels[{i}]", 80) for i, s in enumerate(labels)])
    else:
        raise SpecError(f"{where}: expected a list of numbers or {{at, labels}}")


def _panel(ax, p: dict, where: str) -> None:
    _known(p, where, PANEL_FIELDS)
    items = p.get("items", [])
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise SpecError(f"{where}.items: expected a list of at most {MAX_ITEMS}")
    for i, item in enumerate(items):
        w = f"{where}.items[{i}]"
        if not isinstance(item, dict):
            raise SpecError(f"{w}: expected an object")
        DRAW[_choice(item.get("type"), f"{w}.type", ITEM_TYPES)](ax, item, w)
    frame = _choice(p.get("frame", "open"), f"{where}.frame", {"open", "box", "cross", "off"})
    if frame == "off":
        ax.axis("off")
    elif frame == "open":
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
    elif frame == "cross":
        for s in ("left", "bottom"):
            ax.spines[s].set_position("zero")
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
    for key, fn in (("title", ax.set_title), ("xlabel", ax.set_xlabel), ("ylabel", ax.set_ylabel)):
        if key in p:
            fn(_str(p[key], f"{where}.{key}"))
    if "xscale" in p:
        ax.set_xscale(_choice(p["xscale"], f"{where}.xscale", {"linear", "log"}))
    if "yscale" in p:
        ax.set_yscale(_choice(p["yscale"], f"{where}.yscale", {"linear", "log"}))
    if "xlim" in p:
        ax.set_xlim(*_range(p["xlim"], f"{where}.xlim"))
    if "ylim" in p:
        ax.set_ylim(*_range(p["ylim"], f"{where}.ylim"))
    if "aspect" in p:
        ax.set_aspect(_choice(p["aspect"], f"{where}.aspect", {"equal", "auto"}))
    if p.get("grid") is True:
        ax.grid(True, color="#dddddd", linewidth=0.6)
        ax.set_axisbelow(True)
    if "xticks" in p:
        _ticks(ax, "x", p["xticks"], f"{where}.xticks")
    if "yticks" in p:
        _ticks(ax, "y", p["yticks"], f"{where}.yticks")
    legend = p.get("legend", False)
    if legend is not False:
        loc = "best" if legend is True else _choice(legend, f"{where}.legend", LEGEND_LOCS)
        ax.legend(loc=loc, frameon=False, fontsize=9)


def _safe_matplotlib():
    """matplotlib, set up so nothing outside the engine can change how it runs: its own default settings (never a
    matplotlibrc file from the current folder), the Agg renderer, and no LaTeX (which would start a program)."""
    import importlib.util
    import os

    spec = importlib.util.find_spec("matplotlib")
    if spec and spec.origin:
        rc = Path(spec.origin).parent / "mpl-data" / "matplotlibrc"
        if rc.is_file():
            os.environ["MATPLOTLIBRC"] = str(rc)
    os.environ["MPLBACKEND"] = "Agg"
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update({"text.usetex": False, "font.size": 11, "svg.fonttype": "path", "savefig.facecolor": "white",
                         "figure.facecolor": "white", "axes.titlesize": 12})
    return plt


def load(path: Path) -> list[dict]:
    """The spec file's figures (checked for shape only; each is checked in full as it's drawn)."""
    raw = path.read_bytes()
    if len(raw) > MAX_SPEC_BYTES:
        raise SpecError(f"the spec is over {MAX_SPEC_BYTES // 1024} KB")
    try:
        spec = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise SpecError(f"not readable JSON ({err})") from None
    figures = spec.get("figures") if isinstance(spec, dict) and "figures" in spec else [spec]
    if not isinstance(figures, list) or not figures or len(figures) > MAX_FIGURES:
        raise SpecError(f"expected 1 to {MAX_FIGURES} figures")
    if isinstance(spec, dict) and "figures" in spec:
        _known(spec, "spec", {"figures"})
    return figures


def render(figure: dict, out_dir: Path, where: str = "figure") -> Path:
    """Draw one figure into out_dir (its "file" name, checked) and return the saved file."""
    if not isinstance(figure, dict):
        raise SpecError(f"{where}: expected an object")
    name = figure.get("file")
    if not isinstance(name, str) or not FILE_RE.fullmatch(name):
        raise SpecError(f"{where}.file: a plain name like 'growth-curves.png' (lowercase letters, digits, '-' and "
                        "'_', ending .png or .svg)")
    plt = _safe_matplotlib()
    w, h = _pair(figure.get("size", [6.5, 4.0]), f"{where}.size")
    if not (1 <= w <= 12 and 1 <= h <= 12):
        raise SpecError(f"{where}.size: each side 1 to 12 inches")
    layout = figure.get("layout", [1, 1])
    if not isinstance(layout, list) or len(layout) != 2:
        raise SpecError(f"{where}.layout: expected [rows, cols]")
    rows, cols = _int(layout[0], f"{where}.layout[0]", 1, 4), _int(layout[1], f"{where}.layout[1]", 1, 4)
    panels = figure.get("panels")
    if panels is None:
        panels = [{k: v for k, v in figure.items() if k not in FIGURE_FIELDS or k == "title"}]
        if [rows, cols] != [1, 1]:
            raise SpecError(f"{where}: a figure with a layout lists its \"panels\"")
        _known(figure, where, PANEL_FIELDS | FIGURE_FIELDS)
        title = None
    else:
        _known(figure, where, FIGURE_FIELDS)
        title = figure.get("title")
    if not isinstance(panels, list) or not 1 <= len(panels) <= min(MAX_PANELS, rows * cols):
        raise SpecError(f"{where}.panels: 1 to {rows * cols} panels for a {rows}x{cols} grid")
    fig, axes = plt.subplots(rows, cols, figsize=(w, h), squeeze=False)
    try:
        flat = [a for row in axes for a in row]
        for i, p in enumerate(panels):
            if not isinstance(p, dict):
                raise SpecError(f"{where}.panels[{i}]: expected an object")
            if "font" in p:
                _num(p["font"], f"{where}.panels[{i}].font", 6, 20)
            with plt.rc_context({"font.size": p.get("font", 11)}):
                _panel(flat[i], p, f"{where}.panels[{i}]" if figure.get("panels") is not None else where)
        for a in flat[len(panels):]:
            a.axis("off")
        if title is not None:
            fig.suptitle(_str(title, f"{where}.title"))
        fig.tight_layout()
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / name
        try:
            fig.savefig(out, dpi=200)
        except ValueError as err:  # mathtext that doesn't parse, mostly
            raise SpecError(f"{where}: {err}") from None
        return out
    finally:
        plt.close(fig)


def render_file(spec_path: Path, out_dir: Path) -> dict[str, Any]:
    """Draw every figure in a spec file: {"saved": [...], "errors": [...]} (one bad figure doesn't stop the rest)."""
    saved: list[dict[str, str]] = []
    errors: list[str] = []
    for i, fig in enumerate(load(spec_path)):
        try:
            out = render(fig, out_dir, f"figures[{i}]")
            saved.append({"file": str(out), "typst_path": f"img/{out.name}"})
        except SpecError as err:
            errors.append(str(err))
    return {"saved": saved, "errors": errors}
