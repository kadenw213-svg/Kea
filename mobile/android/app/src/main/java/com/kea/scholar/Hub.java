package com.kea.scholar;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * The phone's connection to the online Kea account server: the person's Kea account and their Kea storage, which Kea on the PC syncs
 * through. The session token lives only here, in Android's encrypted storage (Store.secure), and is added to each
 * request natively; the app's web code never sees it. Requests go out from Java rather than the WebView, so the Hub's
 * cross-site checks (which refuse browser requests from another origin) don't apply.
 */
final class Hub {
    private Hub() {}

    static final class Answer {
        int status;
        String body;
        String etag;
    }

    static String url(Context ctx) {
        return Store.plain(ctx).getString("hubUrl", "");
    }

    // What this phone says it is to servers: "Kea-Phone/<version>" (docs/protocol.md section 0), so a server can say
    // plainly when it's too old. Before the version is known: "Kea for Android", which servers serve as before.
    private static volatile String client = "Kea for Android";
    static String client(Context ctx) {
        if (ctx != null && client.equals("Kea for Android")) {
            try {
                String v = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
                if (v != null && v.matches("\\d+\\.\\d+\\.\\d+.*")) client = "Kea-Phone/" + v;
            } catch (Exception ignored) {}
        }
        return client;
    }

    /**
     * Only an https address (the session token goes with every request to it); anything else is ignored. A different
     * Hub (another scheme, host or port) signs this phone out first: the token and email are forgotten, so a session
     * is never sent to an address it wasn't made for.
     */
    static void setUrl(Context ctx, String url) {
        String u = url == null ? "" : url.trim();
        if (!u.isEmpty() && (!u.toLowerCase().startsWith("https://") || Domains.origin(u).isEmpty())) return;
        u = u.replaceAll("/+$", "");
        if (!sameHub(url(ctx), u)) forget(ctx);
        Store.plain(ctx).edit().putString("hubUrl", u).apply();
    }

    /** Two Hub addresses are the same Hub: the same origin (scheme, host and port). */
    static boolean sameHub(String a, String b) {
        String oa = Domains.origin(a), ob = Domains.origin(b);
        return !oa.isEmpty() && oa.equals(ob);
    }

    static String token(Context ctx) {
        return Store.secure(ctx).getString("hubToken", "");
    }

    static void keep(Context ctx, String token, String email) {
        Store.secure(ctx).edit().putString("hubToken", token).apply();
        Store.plain(ctx).edit().putString("hubEmail", email == null ? "" : email).apply();
    }

    static void forget(Context ctx) {
        Store.secure(ctx).edit().remove("hubToken").apply();
        Store.plain(ctx).edit().remove("hubEmail").apply();
    }

    static String email(Context ctx) {
        return Store.plain(ctx).getString("hubEmail", "");
    }

    /** Only the Hub's own API, on the address set for it. */
    /** How long a request may take by default: connecting, then each read (files can be big). */
    static final int CONNECT_MS = 15000, READ_MS = 60000;

    /** A time limit the app asked for, kept between 1 second and the default. */
    static int limit(int ms, int max) {
        return ms <= 0 ? max : Math.max(1000, Math.min(ms, max));
    }

    private static HttpURLConnection open(Context ctx, String method, String path, boolean auth, String ifMatch, boolean ifNoneMatch) throws Exception {
        return open(ctx, method, path, auth, ifMatch, ifNoneMatch, CONNECT_MS, READ_MS);
    }

    /**
     * Only the account server's own API, on the address set for it. `connectMs`/`readMs`: shorter limits for the
     * background "is it there" checks and sign-ins, so not reaching the server is a quick, normal answer.
     */
    private static HttpURLConnection open(Context ctx, String method, String path, boolean auth, String ifMatch, boolean ifNoneMatch, int connectMs, int readMs) throws Exception {
        String base = url(ctx);
        if (base.isEmpty()) throw new IllegalStateException("This copy of Kea has no Kea account address yet.");
        if (path == null || !path.startsWith("/v1/") || path.contains("..")) throw new IllegalArgumentException("Not a Kea account address.");
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(limit(connectMs, CONNECT_MS));
        c.setReadTimeout(limit(readMs, READ_MS));
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("x-kea-client", client(ctx));
        if (auth) {
            String t = token(ctx);
            if (!t.isEmpty()) c.setRequestProperty("authorization", "Bearer " + t);
        }
        if (ifMatch != null && !ifMatch.isEmpty()) c.setRequestProperty("if-match", "\"" + ifMatch + "\"");
        if (ifNoneMatch) c.setRequestProperty("if-none-match", "*");
        return c;
    }

    private static String readText(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream s = in) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
        }
        return out.toString("UTF-8");
    }

    private static String version(HttpURLConnection c) {
        String e = c.getHeaderField("etag");
        return e == null ? "" : e.replace("\"", "").trim();
    }

    /**
     * One request with a text (JSON, or a file's text for PUT) body. `keepToken`: a sign-in; the session token in the
     * answer is kept here and taken out of what the app gets back.
     */
    static Answer request(Context ctx, String method, String path, String body, String contentType, boolean auth, String ifMatch, boolean ifNoneMatch, boolean keepToken) throws Exception {
        return request(ctx, method, path, body, contentType, auth, ifMatch, ifNoneMatch, keepToken, CONNECT_MS, READ_MS);
    }

    static Answer request(Context ctx, String method, String path, String body, String contentType, boolean auth, String ifMatch, boolean ifNoneMatch, boolean keepToken, int connectMs, int readMs) throws Exception {
        HttpURLConnection c = open(ctx, method, path, auth, ifMatch, ifNoneMatch, connectMs, readMs);
        try {
            if (body != null && !"GET".equals(method)) {
                byte[] bytes = body.getBytes("UTF-8");
                c.setDoOutput(true);
                c.setRequestProperty("content-type", contentType == null ? "application/json" : contentType);
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(bytes);
                }
            }
            Answer a = new Answer();
            a.status = c.getResponseCode();
            a.etag = version(c);
            a.body = readText(a.status >= 400 ? c.getErrorStream() : c.getInputStream());
            if (keepToken && a.status >= 200 && a.status < 300) {
                JSONObject j = new JSONObject(a.body);
                String t = j.optString("token", "");
                if (!t.isEmpty()) {
                    // (A Kea Hub 0.5 answers { token, account }; the Kea account server { token, me: { account } }.)
                    JSONObject acct = j.optJSONObject("account");
                    if (acct == null && j.optJSONObject("me") != null) acct = j.optJSONObject("me").optJSONObject("account");
                    keep(ctx, t, acct == null ? "" : acct.optString("email", ""));
                    j.remove("token");
                    a.body = j.toString();
                }
            }
            return a;
        } finally {
            c.disconnect();
        }
    }

    // ---------- The Kea accounts kept on this phone (account.ts / accountCore.ts) ----------

    /** The record of accounts made or signed in on this phone, with their password verifiers: encrypted storage only. */
    static String accounts(Context ctx) {
        return Store.secure(ctx).getString("keaAccounts", "");
    }

    static void keepAccounts(Context ctx, String text) {
        Store.secure(ctx).edit().putString("keaAccounts", text == null ? "" : text).apply();
    }

    // ---------- Google and Microsoft sign-in: trading the code for tokens ----------

    /** The only two places a sign-in code is sent. */
    static String tokenUrl(String provider) {
        if ("google".equals(provider)) return "https://oauth2.googleapis.com/token";
        if ("microsoft".equals(provider)) return "https://login.microsoftonline.com/common/oauth2/v2.0/token";
        return null;
    }

    /** POST the form (code, PKCE verifier, client id; no secret) to the provider's token address: { status, body }. */
    static Answer oauthToken(String provider, String form) throws Exception {
        String u = tokenUrl(provider);
        if (u == null) throw new IllegalArgumentException("Not a sign-in Kea knows.");
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(8000);
            c.setReadTimeout(20000);
            c.setInstanceFollowRedirects(false);
            byte[] bytes = (form == null ? "" : form).getBytes("UTF-8");
            c.setDoOutput(true);
            c.setRequestProperty("content-type", "application/x-www-form-urlencoded");
            c.setRequestProperty("accept", "application/json");
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = c.getOutputStream()) {
                os.write(bytes);
            }
            Answer a = new Answer();
            a.status = c.getResponseCode();
            a.body = readText(a.status >= 400 ? c.getErrorStream() : c.getInputStream());
            a.etag = "";
            return a;
        } finally {
            c.disconnect();
        }
    }

    static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /** A file under `root` named by a relative path, never outside it. */
    static File inside(File root, String rel) throws Exception {
        File f = new File(root, rel);
        if (rel == null || rel.isEmpty() || rel.contains("..") || !f.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IllegalArgumentException("Not one of Kea's files.");
        return f;
    }

    /**
     * Download one file from Kea storage straight to `to` (written to a .part file first, then swapped in). When the file
     * there already has the size and sha256 the Hub lists, nothing is downloaded. Returns { status, version, size, skipped }.
     */
    static JSONObject download(Context ctx, String path, File to, long size, String sha) throws Exception {
        JSONObject r = new JSONObject();
        if (sha != null && !sha.isEmpty() && to.isFile() && to.length() == size && sha.equals(sha256(to))) {
            r.put("status", 200);
            r.put("skipped", true);
            r.put("size", size);
            return r;
        }
        HttpURLConnection c = open(ctx, "GET", path, true, null, false);
        try {
            int status = c.getResponseCode();
            r.put("status", status);
            if (status != 200) {
                r.put("body", readText(c.getErrorStream()));
                return r;
            }
            to.getParentFile().mkdirs();
            File tmp = new File(to.getPath() + ".part");
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            long total = 0;
            try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(tmp)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    md.update(buf, 0, n);
                    total += n;
                }
            }
            // The Hub sends each file's sha256: a download cut short never replaces a good copy.
            String want = c.getHeaderField("x-kea-sha256");
            StringBuilder got = new StringBuilder();
            for (byte b : md.digest()) got.append(String.format("%02x", b));
            if (want != null && !want.equalsIgnoreCase(got.toString())) {
                tmp.delete();
                r.put("status", 0);
                r.put("body", "{\"error\":\"The download didn't arrive whole. It's tried again next time.\"}");
                return r;
            }
            to.delete();
            if (!tmp.renameTo(to)) throw new java.io.IOException("Couldn't save " + to.getName());
            r.put("version", version(c));
            r.put("size", total);
            return r;
        } finally {
            c.disconnect();
        }
    }
}
