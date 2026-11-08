package com.kea.scholar;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * The organization servers (KeaS) this phone's Kea accounts joined, and their passes and sessions (protocol section 2).
 * All of it lives in Android's encrypted storage (Store.secure, "keaOrgs"), keyed by the Kea account on this phone and
 * the server's id. Passes and server session tokens never leave this class: the app's web code gets only a view of
 * each server (when its pass was made and ends, whether there's a session) and the servers' answers.
 *
 * The server's identity is checked here with Android's own Ed25519 (java.security, Android 13 and later; "unavailable"
 * before that, when the app checks it with the WebView's WebCrypto instead). A pass is only ever sent to an address
 * whose identity was checked for that server id in the last few minutes, and only a pass made for that server.
 */
final class Orgs {
    private Orgs() {}

    static final String KEY = "keaOrgs";
    static final int CONNECT_MS = 8000, READ_MS = 20000;
    /** How long an identity check lets a pass be sent to that address. */
    static final long CHECKED_MS = 10 * 60_000L;
    private static final Object LOCK = new Object();
    private static final SecureRandom RNG = new SecureRandom();
    /** address -> { serverId, at } checked by identity() (this run of the app only). */
    private static final Map<String, Object[]> checked = new HashMap<>();

    static final class Answer {
        int status;
        String body;
    }

    // ---------- pure parts (OrgsTest) ----------

    /** A server address: https anywhere, plain http only to the phone itself. Its origin, or null. */
    static String cleanUrl(String input) {
        if (input == null) return null;
        try {
            URI u = new URI(input.trim());
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
            String host = u.getHost();
            if (host == null || host.isEmpty() || u.getUserInfo() != null) return null;
            boolean loop = host.equals("localhost") || host.equals("[::1]") || host.equals("::1") || host.matches("127\\.\\d+\\.\\d+\\.\\d+");
            if (!scheme.equals("https") && !(scheme.equals("http") && loop)) return null;
            int port = u.getPort();
            return scheme + "://" + host.toLowerCase() + (port > 0 && !(scheme.equals("https") && port == 443) && !(scheme.equals("http") && port == 80) ? ":" + port : "");
        } catch (Exception e) {
            return null;
        }
    }

    static boolean pathOk(String p) {
        return p != null && p.startsWith("/v1/") && !p.contains("..") && p.length() < 2000 && !p.contains("\n") && !p.contains("\r");
    }

    private static final String B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    /** base64url (or plain base64) to bytes; anything that isn't base64 gives no bytes. (java.util.Base64 needs Android 8.) */
    static byte[] unb64url(String s) {
        if (s == null) return new byte[0];
        String t = s.replace('+', '-').replace('/', '_').replaceAll("=+$", "");
        if (t.length() % 4 == 1) return new byte[0];
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int buf = 0, bits = 0;
        for (int i = 0; i < t.length(); i++) {
            int v = B64.indexOf(t.charAt(i));
            if (v < 0) return new byte[0];
            buf = ((buf << 6) | v) & 0xffffff;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out.write((buf >> bits) & 0xff);
            }
        }
        return out.toByteArray();
    }

    static String b64url(byte[] b) {
        StringBuilder sb = new StringBuilder();
        int i = 0;
        for (; i + 2 < b.length; i += 3) {
            int n = ((b[i] & 0xff) << 16) | ((b[i + 1] & 0xff) << 8) | (b[i + 2] & 0xff);
            sb.append(B64.charAt(n >> 18)).append(B64.charAt((n >> 12) & 63)).append(B64.charAt((n >> 6) & 63)).append(B64.charAt(n & 63));
        }
        if (b.length - i == 1) {
            int n = (b[i] & 0xff) << 16;
            sb.append(B64.charAt(n >> 18)).append(B64.charAt((n >> 12) & 63));
        } else if (b.length - i == 2) {
            int n = ((b[i] & 0xff) << 16) | ((b[i + 1] & 0xff) << 8);
            sb.append(B64.charAt(n >> 18)).append(B64.charAt((n >> 12) & 63)).append(B64.charAt((n >> 6) & 63));
        }
        return sb.toString();
    }

    static String serverIdOf(byte[] raw) throws Exception {
        return b64url(MessageDigest.getInstance("SHA-256").digest(raw)).substring(0, 22);
    }

    /** The X.509 form of a raw Ed25519 public key (the 12-byte header for OID 1.3.101.112, then the key). */
    static byte[] spki(byte[] raw) {
        byte[] head = { 0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00 };
        byte[] out = new byte[head.length + raw.length];
        System.arraycopy(head, 0, out, 0, head.length);
        System.arraycopy(raw, 0, out, head.length, raw.length);
        return out;
    }

    /** Ed25519 with the phone's own crypto: Boolean, or null when this Android has none (before Android 13). */
    static Boolean ed25519(byte[] raw, byte[] message, byte[] sig) {
        Signature s;
        PublicKey key;
        try {
            KeyFactory kf;
            try {
                kf = KeyFactory.getInstance("Ed25519");
            } catch (NoSuchAlgorithmException e) {
                kf = KeyFactory.getInstance("EdDSA");
            }
            key = kf.generatePublic(new X509EncodedKeySpec(spki(raw)));
            try {
                s = Signature.getInstance("Ed25519");
            } catch (NoSuchAlgorithmException e) {
                s = Signature.getInstance("EdDSA");
            }
        } catch (NoSuchAlgorithmException e) {
            return null;
        } catch (Exception e) {
            return Boolean.FALSE;
        }
        try {
            s.initVerify(key);
            s.update(message);
            return s.verify(sig);
        } catch (Exception e) {
            return Boolean.FALSE;
        }
    }

    /**
     * A server's /v1/identity answer for `nonce`: "ok", "bad" (wrong key, id or signature), or "unavailable" (the id
     * matches its key, and this Android can't check the signature itself).
     */
    static String verifyIdentity(JSONObject a, String nonce) {
        JSONObject jwk = a.optJSONObject("publicKey");
        if (jwk == null) return "bad";
        return verifyIdentity(jwk.optString("kty", ""), jwk.optString("crv", ""), jwk.optString("x", ""), a.optString("serverId", ""), a.optString("sig", ""), nonce);
    }

    static String verifyIdentity(String kty, String crv, String x, String serverId, String sigText, String nonce) {
        try {
            if (!"OKP".equals(kty) || !"Ed25519".equals(crv)) return "bad";
            byte[] raw = unb64url(x);
            if (raw.length != 32) return "bad";
            String id = serverIdOf(raw);
            if (!id.equals(serverId)) return "bad";
            byte[] sig = unb64url(sigText);
            if (sig.length != 64) return "bad";
            Boolean ok = ed25519(raw, ("kea-server-identity:" + id + ":" + nonce).getBytes(StandardCharsets.UTF_8), sig);
            return ok == null ? "unavailable" : ok ? "ok" : "bad";
        } catch (Exception e) {
            return "bad";
        }
    }

    /** A JWT-shaped pass's payload (not checked: the server checks the signature), or null. */
    static JSONObject passPayload(String pass) {
        try {
            String[] p = pass.split("\\.");
            if (p.length != 3) return null;
            return new JSONObject(new String(unb64url(p[1]), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    /** Only a pass made for this server is ever kept for it (and so handed to it). */
    static boolean passFor(String pass, String serverId) {
        JSONObject p = passPayload(pass);
        return p != null && audFor(p.optString("aud", ""), serverId);
    }

    static boolean audFor(String aud, String serverId) {
        return serverId != null && serverId.matches("[A-Za-z0-9_-]{22}") && ("keas:" + serverId).equals(aud);
    }

    /** exp in ms, whether sent in seconds (JWT style) or ms. */
    static long asMs(double t) {
        return t <= 0 ? 0 : t < 1e12 ? (long) (t * 1000) : (long) t;
    }

    static String key(String account, String serverId) {
        return account + "|" + serverId;
    }

    /** What the app may see of a server: never its pass or session. */
    static JSONObject view(JSONObject e) throws Exception {
        JSONObject v = new JSONObject();
        v.put("serverId", e.optString("serverId"));
        v.put("url", e.optString("url"));
        v.put("name", e.isNull("name") ? JSONObject.NULL : e.optString("name"));
        v.put("joinedAt", e.optLong("joinedAt", 0));
        v.put("signedOut", e.optBoolean("signedOut", false));
        v.put("message", e.isNull("message") || !e.has("message") ? JSONObject.NULL : e.optString("message"));
        v.put("passAt", e.has("passAt") ? e.optLong("passAt") : JSONObject.NULL);
        v.put("passExp", e.has("passExp") ? e.optLong("passExp") : JSONObject.NULL);
        v.put("hasPass", !e.optString("pass", "").isEmpty());
        v.put("hasToken", !e.optString("token", "").isEmpty());
        return v;
    }

    static JSONArray views(JSONObject all, String account) throws Exception {
        JSONArray out = new JSONArray();
        for (Iterator<String> it = all.keys(); it.hasNext(); ) {
            String k = it.next();
            JSONObject e = all.optJSONObject(k);
            if (e != null && account.equals(e.optString("account"))) out.put(view(e));
        }
        return out;
    }

    /** The token from a server's /v1/auth/pass answer, and that answer without it. */
    static String[] takeToken(String body) {
        try {
            JSONObject j = new JSONObject(body);
            String t = j.optString("token", j.optString("session", ""));
            j.remove("token");
            j.remove("session");
            return new String[] { t, j.toString() };
        } catch (Exception e) {
            return new String[] { "", "{}" };
        }
    }

    // ---------- the record ----------
    static JSONObject load(Context ctx) {
        try {
            return new JSONObject(Store.secure(ctx).getString(KEY, "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    static void save(Context ctx, JSONObject all) {
        Store.secure(ctx).edit().putString(KEY, all.toString()).apply();
    }

    static JSONArray list(Context ctx, String account) throws Exception {
        synchronized (LOCK) {
            return views(load(ctx), account);
        }
    }

    private static JSONObject entry(JSONObject all, String account, String serverId) {
        return all.optJSONObject(key(account, serverId));
    }

    static void add(Context ctx, String account, String url, String serverId, String name) throws Exception {
        String u = cleanUrl(url);
        if (u == null || account == null || account.isEmpty()) throw new IllegalArgumentException("Not a server address.");
        if (!checkedFor(u, serverId)) throw new IllegalStateException("Kea hasn't checked this server's identity.");
        synchronized (LOCK) {
            JSONObject all = load(ctx);
            if (entry(all, account, serverId) != null) return;
            JSONObject e = new JSONObject();
            e.put("account", account);
            e.put("url", u);
            e.put("serverId", serverId);
            e.put("name", name == null ? JSONObject.NULL : name);
            e.put("joinedAt", System.currentTimeMillis());
            all.put(key(account, serverId), e);
            save(ctx, all);
        }
    }

    static void update(Context ctx, String account, String serverId, JSONObject patch) throws Exception {
        synchronized (LOCK) {
            JSONObject all = load(ctx);
            JSONObject e = entry(all, account, serverId);
            if (e == null) return;
            if (patch.has("name")) e.put("name", patch.isNull("name") ? JSONObject.NULL : patch.optString("name"));
            if (patch.has("signedOut")) e.put("signedOut", patch.optBoolean("signedOut"));
            if (patch.has("message")) e.put("message", patch.isNull("message") ? JSONObject.NULL : patch.optString("message"));
            save(ctx, all);
        }
    }

    static void remove(Context ctx, String account, String serverId) {
        synchronized (LOCK) {
            JSONObject all = load(ctx);
            all.remove(key(account, serverId));
            save(ctx, all);
        }
    }

    static void dropSession(Context ctx, String account, String serverId) throws Exception {
        synchronized (LOCK) {
            JSONObject all = load(ctx);
            JSONObject e = entry(all, account, serverId);
            if (e == null) return;
            e.remove("token");
            e.remove("tokenAt");
            save(ctx, all);
        }
    }

    private static void patchSecret(Context ctx, String account, String serverId, String[] kv) throws Exception {
        synchronized (LOCK) {
            JSONObject all = load(ctx);
            JSONObject e = entry(all, account, serverId);
            if (e == null) throw new IllegalStateException("This server isn't one of yours on this phone.");
            for (int i = 0; i + 1 < kv.length; i += 2) e.put(kv[i], kv[i + 1]);
            save(ctx, all);
        }
    }

    // ---------- identity ----------
    static boolean checkedFor(String url, String serverId) {
        synchronized (checked) {
            Object[] c = checked.get(url);
            return c != null && serverId != null && serverId.equals(c[0]) && System.currentTimeMillis() - (Long) c[1] < CHECKED_MS;
        }
    }

    /** GET <url>/v1/identity with a fresh nonce: { status, body, nonce, check }. */
    static JSONObject identity(String url) throws Exception {
        String u = cleanUrl(url);
        if (u == null) throw new IllegalArgumentException("Use the server's https:// address.");
        byte[] n = new byte[16];
        RNG.nextBytes(n);
        StringBuilder nonce = new StringBuilder();
        for (byte b : n) nonce.append(String.format("%02x", b));
        Answer a = http(u, "GET", "/v1/identity?nonce=" + nonce, null, null);
        JSONObject r = new JSONObject();
        r.put("status", a.status);
        r.put("body", a.body);
        r.put("nonce", nonce.toString());
        String check = "bad";
        if (a.status == 200) {
            try {
                JSONObject j = new JSONObject(a.body);
                check = verifyIdentity(j, nonce.toString());
                // (Before Android 13 the app checks the signature with WebCrypto; the id still has to match the key.)
                if (!"bad".equals(check)) synchronized (checked) {
                    checked.put(u, new Object[] { j.optString("serverId"), System.currentTimeMillis() });
                }
            } catch (Exception ignored) {
            }
        }
        r.put("check", check);
        return r;
    }

    // ---------- passes and sessions ----------

    /** A pass from the Kea account server (with the account session), kept here: { status, body (no pass), exp }. */
    static JSONObject fetchPass(Context ctx, String account, String serverId) throws Exception {
        JSONObject e;
        synchronized (LOCK) {
            e = entry(load(ctx), account, serverId);
        }
        if (e == null) throw new IllegalStateException("This server isn't one of yours on this phone.");
        Hub.Answer a = Hub.request(ctx, "POST", "/v1/pass", new JSONObject().put("serverId", serverId).toString(), null, true, null, false, false, CONNECT_MS, READ_MS);
        JSONObject r = new JSONObject();
        r.put("status", a.status);
        if (a.status < 200 || a.status >= 300) {
            r.put("body", a.body == null ? "" : a.body);
            return r;
        }
        JSONObject j = new JSONObject(a.body);
        String pass = j.optString("pass", "");
        if (!passFor(pass, serverId)) {
            r.put("status", 502);
            r.put("body", "{\"error\":\"The Kea account server sent a pass for another server. Kea didn't use it.\",\"wrongAudience\":true}");
            return r;
        }
        JSONObject p = passPayload(pass);
        long exp = asMs(j.has("exp") ? j.optDouble("exp") : p.optDouble("exp", 0));
        patchSecret(ctx, account, serverId, new String[] { "pass", pass });
        synchronized (LOCK) {
            JSONObject all = load(ctx);
            JSONObject x = entry(all, account, serverId);
            if (x != null) {
                x.put("passExp", exp);
                x.put("passAt", System.currentTimeMillis());
                save(ctx, all);
            }
        }
        r.put("exp", exp);
        r.put("body", new JSONObject().put("exp", exp).toString());
        return r;
    }

    /** The kept pass for the server's own session (kept here): { status, body (no token) }. */
    static Answer signIn(Context ctx, String account, String serverId) throws Exception {
        JSONObject e;
        synchronized (LOCK) {
            e = entry(load(ctx), account, serverId);
        }
        if (e == null) throw new IllegalStateException("This server isn't one of yours on this phone.");
        String url = e.optString("url"), pass = e.optString("pass", "");
        Answer out = new Answer();
        if (pass.isEmpty() || !passFor(pass, serverId)) {
            out.status = 401;
            out.body = "{\"error\":\"No pass for this server yet.\",\"noPass\":true}";
            return out;
        }
        if (!checkedFor(url, serverId)) {
            out.status = 495;
            out.body = "{\"error\":\"Kea checks the server's identity before signing in to it.\",\"identity\":false}";
            return out;
        }
        Answer a = http(url, "POST", "/v1/auth/pass", new JSONObject().put("pass", pass).toString(), null);
        if (a.status >= 200 && a.status < 300) {
            String[] t = takeToken(a.body);
            if (t[0].isEmpty()) {
                out.status = 502;
                out.body = "{\"error\":\"The server didn't start a session.\"}";
                return out;
            }
            patchSecret(ctx, account, serverId, new String[] { "token", t[0], "tokenAt", String.valueOf(System.currentTimeMillis()) });
            a.body = t[1];
        }
        return a;
    }

    /** One request to a joined server with its session: { status, body }. */
    static Answer request(Context ctx, String account, String serverId, String method, String path, String body) throws Exception {
        if (!pathOk(path)) throw new IllegalArgumentException("Not an organization address.");
        if (!"GET".equals(method) && !"POST".equals(method)) throw new IllegalArgumentException("Not an organization request.");
        JSONObject e;
        synchronized (LOCK) {
            e = entry(load(ctx), account, serverId);
        }
        if (e == null) throw new IllegalStateException("This server isn't one of yours on this phone.");
        String token = e.optString("token", "");
        if (token.isEmpty()) {
            Answer a = new Answer();
            a.status = 401;
            a.body = "{\"error\":\"No session yet.\",\"noSession\":true}";
            return a;
        }
        return http(e.optString("url"), method, path, "GET".equals(method) ? null : body, token);
    }

    // ---------- HTTP ----------
    static Answer http(String base, String method, String path, String body, String token) throws Exception {
        if (cleanUrl(base) == null || !pathOk(path)) throw new IllegalArgumentException("Not an organization address.");
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(CONNECT_MS);
            c.setReadTimeout(READ_MS);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("x-kea", "1");
            c.setRequestProperty("x-kea-client", "Kea for Android");
            c.setRequestProperty("accept", "application/json");
            if (token != null && !token.isEmpty()) c.setRequestProperty("authorization", "Bearer " + token);
            if (body != null) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json");
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(bytes);
                }
            }
            Answer a = new Answer();
            a.status = c.getResponseCode();
            a.body = read(a.status >= 400 ? c.getErrorStream() : c.getInputStream());
            return a;
        } finally {
            c.disconnect();
        }
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream s = in) {
            byte[] buf = new byte[16384];
            int n;
            long total = 0;
            while ((n = s.read(buf)) > 0) {
                total += n;
                // (Org answers are small; a server can't fill the phone's memory.)
                if (total > 8L * 1024 * 1024) throw new java.io.IOException("The answer was too big.");
                out.write(buf, 0, n);
            }
        }
        return out.toString("UTF-8");
    }
}
