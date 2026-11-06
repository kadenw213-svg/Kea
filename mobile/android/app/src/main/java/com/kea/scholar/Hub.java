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
 * The phone's connection to the Kea Hub: the person's Kea account and their Kea storage, which Kea on the PC syncs
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
    private static HttpURLConnection open(Context ctx, String method, String path, boolean auth, String ifMatch, boolean ifNoneMatch) throws Exception {
        String base = url(ctx);
        if (base.isEmpty()) throw new IllegalStateException("Enter your Kea Hub's address first.");
        if (path == null || !path.startsWith("/v1/") || path.contains("..")) throw new IllegalArgumentException("Not a Kea Hub address.");
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("x-kea-client", "Kea for Android");
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
        HttpURLConnection c = open(ctx, method, path, auth, ifMatch, ifNoneMatch);
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
                    JSONObject acct = j.optJSONObject("account");
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
