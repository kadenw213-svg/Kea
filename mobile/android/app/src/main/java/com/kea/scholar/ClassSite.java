package com.kea.scholar;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The class site (D2L Brightspace or Canvas), the way Kea on the PC does it: requests carry the phone's own signed-in session
 * (Android's WebView cookie store), and when that session has run out Kea signs in again by itself, in a hidden
 * WebView, with the login saved in encrypted storage. Only if that fails (a new prompt, a code) is the student asked.
 */
final class ClassSite {
    private ClassSite() {}

    interface Done {
        void run(boolean ok);
    }

    static final Handler MAIN = new Handler(Looper.getMainLooper());

    static String host(String url) {
        try {
            String h = Uri.parse(url).getHost();
            return h == null ? "" : h.toLowerCase();
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * A Canvas school: what the PC said (in the classes to watch), or, before that, the address (D2L homes are under
     * /d2l/, Canvas sites are mostly *.instructure.com).
     */
    static boolean canvas(Context ctx) {
        try {
            String p = new JSONObject(Store.plain(ctx).getString("watch", "{}")).optString("platform", "");
            if (!p.isEmpty()) return p.equals("canvas");
        } catch (Exception ignored) {
        }
        String home = Store.home(ctx);
        return !home.toLowerCase().contains("/d2l/") && host(home).endsWith("instructure.com");
    }

    /** On the class site itself, not a sign-in page. */
    static boolean onSite(Context ctx, String url) {
        String home = Store.home(ctx);
        return !home.isEmpty() && host(url).equals(host(home)) && !url.matches("(?i).*(/d2l/login|/login).*");
    }

    /**
     * Whether the saved login may be typed into this page: only the sign-in page it was saved on (its exact host, over
     * https). A login saved before Kea kept that host is only filled on the school's own domain or a well-known
     * sign-in service, and the host is then remembered. Never on any other page, so a lookalike page linked from a
     * course can't collect the password.
     */
    static boolean mayFill(Context ctx, String url) {
        if (url == null || !url.toLowerCase().startsWith("https://")) return false;
        String h = host(url).toLowerCase();
        String saved = Store.secure(ctx).getString("loginHost", "");
        if (!saved.isEmpty()) return h.equals(saved);
        String[] parts = host(Store.home(ctx)).toLowerCase().split("\\.");
        String school = parts.length >= 2 ? parts[parts.length - 2] + "." + parts[parts.length - 1] : "";
        boolean known = (!school.isEmpty() && (h.equals(school) || h.endsWith("." + school)))
            || h.equals("login.microsoftonline.com") || h.equals("login.live.com") || h.equals("accounts.google.com")
            || h.endsWith(".okta.com") || h.endsWith(".onelogin.com") || h.endsWith(".duosecurity.com");
        if (known) Store.secure(ctx).edit().putString("loginHost", h).apply();
        return known;
    }

    // ---------- Requests with the signed-in session ----------
    static final class Answer {
        int status;
        String body = "";
        String location = "";
    }

    static Answer request(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null) c.setRequestProperty("Cookie", cookies);
        c.setRequestProperty("Accept", "application/json, text/plain, */*");
        Answer a = new Answer();
        a.status = c.getResponseCode();
        // Keep any refreshed session cookies.
        Map<String, List<String>> headers = c.getHeaderFields();
        List<String> set = headers.get("Set-Cookie");
        if (set != null) for (String s : set) CookieManager.getInstance().setCookie(url, s);
        String loc = c.getHeaderField("Location");
        a.location = loc == null ? "" : loc;
        InputStream in = a.status >= 400 ? c.getErrorStream() : c.getInputStream();
        if (in != null) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            // (Canvas starts its JSON with "while(1);" for a signed-in session.)
            a.body = out.toString("UTF-8").replaceFirst("^while\\(1\\);", "");
            in.close();
        }
        c.disconnect();
        return a;
    }

    /** A form POST with the signed-in session (Canvas: its CSRF token, from the session's cookie, goes along). */
    static Answer postForm(String url, String form) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null) {
            c.setRequestProperty("Cookie", cookies);
            for (String part : cookies.split(";")) {
                String[] kv = part.trim().split("=", 2);
                if (kv.length == 2 && kv[0].equals("_csrf_token")) c.setRequestProperty("X-CSRF-Token", java.net.URLDecoder.decode(kv[1], "UTF-8"));
            }
        }
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        c.setRequestProperty("Accept", "application/json, text/plain, */*");
        c.getOutputStream().write(form.getBytes("UTF-8"));
        Answer a = new Answer();
        a.status = c.getResponseCode();
        c.disconnect();
        return a;
    }

    static boolean needsSignIn(Answer a) {
        return a.status == 401 || a.status == 403 || (a.status >= 300 && a.status < 400);
    }

    /** GET with the session, signing in once (hidden) when the session has run out. Call off the main thread. */
    static Answer get(Context ctx, String url) throws Exception {
        Answer a = request(url);
        if (needsSignIn(a)) {
            if (signInBlocking(ctx, 60)) a = request(url);
        }
        return a;
    }

    static boolean signedIn(Context ctx) {
        String home = Store.home(ctx);
        if (home.isEmpty()) return false;
        try {
            Answer a = request(Uri.parse(home).buildUpon().encodedPath(canvas(ctx) ? "/api/v1/users/self" : "/d2l/api/lp/1.0/users/whoami").clearQuery().build().toString());
            return a.status == 200;
        } catch (Exception e) {
            return false;
        }
    }

    // ---------- Signing in by itself ----------
    static boolean signInBlocking(Context ctx, int seconds) {
        CountDownLatch latch = new CountDownLatch(1);
        final boolean[] ok = {false};
        signIn(ctx, (r) -> {
            ok[0] = r;
            latch.countDown();
        });
        try {
            latch.await(seconds, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
        }
        return ok[0];
    }

    /** Sign in with the saved login in a hidden WebView. Calls back on the main thread. */
    @SuppressLint("SetJavaScriptEnabled")
    static void signIn(Context ctx, Done done) {
        Context app = ctx.getApplicationContext();
        String home = Store.home(app);
        SharedPreferences sec = Store.secure(app);
        String user = sec.getString("user", "");
        String pass = sec.getString("pass", "");
        if (home.isEmpty() || pass.isEmpty()) {
            MAIN.post(() -> done.run(false));
            return;
        }
        MAIN.post(() -> {
            CookieManager.getInstance().setAcceptCookie(true);
            WebView wv = new WebView(app);
            WebSettings s = wv.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            final boolean[] finished = {false};
            final int[] tries = {0};
            Runnable end = () -> {};
            Done finish = (r) -> {
                if (finished[0]) return;
                finished[0] = true;
                CookieManager.getInstance().flush();
                wv.stopLoading();
                wv.destroy();
                done.run(r);
            };
            wv.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    if (finished[0]) return;
                    if (onSite(app, url)) {
                        finish.run(true);
                        return;
                    }
                    if (tries[0]++ >= 4 || !mayFill(app, url)) return;
                    // Give the sign-in page a moment to draw its fields, then fill and press its own button.
                    MAIN.postDelayed(() -> {
                        if (!finished[0]) view.evaluateJavascript(fillScript(user, pass), null);
                    }, 900);
                }
            });
            MAIN.postDelayed(() -> finish.run(false), 40000);
            wv.loadUrl(home);
        });
    }

    static String js(String s) {
        return JSONObject.quote(s == null ? "" : s);
    }

    /** Fills a sign-in page with the saved login and presses the page's own button (same logic as Kea on the PC). */
    static String fillScript(String user, String pass) {
        return "(function(){var U=" + js(user) + ",P=" + js(pass) + ";"
            + "function vis(e){return !!e&&e.offsetParent!==null&&!e.disabled;}"
            + "function set(e,v){var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value');d.set.call(e,v);"
            + "e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}"
            + "function press(root){var bs=[].slice.call((root||document).querySelectorAll('button,input[type=submit],input[type=button]'));"
            + "var b=bs.filter(function(x){return vis(x)&&/sign ?in|log ?in|next|continue|submit/i.test(x.innerText||x.value||'');})[0]"
            + "||(root||document).querySelector('button[type=submit],input[type=submit],button:not([type])');"
            + "if(b&&vis(b)){b.click();return true;}if(root&&root.requestSubmit){root.requestSubmit();return true;}return false;}"
            + "var pw=[].slice.call(document.querySelectorAll('input[type=password]')).filter(vis)[0];"
            + "var txt=[].slice.call(document.querySelectorAll('input[type=text],input[type=email],input:not([type])')).filter(vis);"
            + "if(pw){var u=txt.filter(function(x){return !pw.form||x.form===pw.form;})[0];if(u&&!u.value&&U)set(u,U);set(pw,P);return press(pw.form);}"
            + "if(txt[0]&&U){set(txt[0],U);return press(txt[0].form);}"
            + "var yes=document.querySelector('#idSIButton9,input[type=submit][value=Yes]');if(vis(yes)){yes.click();return true;}"
            + "return false;})()";
    }

    /** Reports the login the student types into a sign-in page (only used in Kea's own visible window). */
    static final String CAPTURE_SCRIPT = "(function(){if(window.__keaCap)return;window.__keaCap=1;"
        + "function vis(e){return !!e&&e.offsetParent!==null;}"
        + "function rep(){try{var pw=[].slice.call(document.querySelectorAll('input[type=password]')).filter(function(x){return x.value;})[0];"
        + "var u=[].slice.call(document.querySelectorAll('input[type=text],input[type=email],input:not([type])')).filter(function(x){return vis(x)&&x.value;})[0];"
        + "if(pw||u)KeaLogin.save(u?u.value:'',pw?pw.value:'',location.href);}catch(e){}}"
        + "document.addEventListener('submit',rep,true);"
        + "document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('button,input[type=submit],input[type=button],a[role=button]');if(b)rep();},true);"
        + "document.addEventListener('keydown',function(e){if(e.key==='Enter')rep();},true);"
        + "window.addEventListener('pagehide',rep,true);})()";
}
