package com.kea.scholar;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.IDN;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Addresses and domains, without Android (so it's tested on the PC): which site an address belongs to by the public
 * suffix list (res/raw/public_suffixes, from publicsuffix.org), an address's origin, and the rules for where Kea's saved
 * login and the class-site session may go.
 */
final class Domains {
    private Domains() {}

    private static final Set<String> RULES = new HashSet<>();
    private static final Set<String> WILD = new HashSet<>();
    private static final Set<String> EXCEPT = new HashSet<>();
    private static volatile boolean loaded = false;

    /**
     * Class-site services where each school has its own host: two schools on the same service are different sites,
     * so the school's own host counts as its domain there.
     */
    private static final String[] LMS_SERVICES = { "instructure.com", "brightspace.com", "desire2learn.com", "d2l.com", "blackboard.com", "moodlecloud.com" };

    /** The public suffix list (one rule per line; comments and blank lines skipped). Loaded once. */
    static synchronized void load(InputStream in) throws java.io.IOException {
        if (loaded) return;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                line = line.trim();
                int sp = line.indexOf(' ');
                if (sp >= 0) line = line.substring(0, sp);
                if (line.isEmpty() || line.startsWith("//")) continue;
                if (line.startsWith("!")) EXCEPT.add(ascii(line.substring(1)));
                else if (line.startsWith("*.")) WILD.add(ascii(line.substring(2)));
                else RULES.add(ascii(line));
            }
        }
        for (String s : LMS_SERVICES) RULES.add(s);
        loaded = true;
    }

    static boolean loaded() {
        return loaded;
    }

    private static String ascii(String s) {
        try {
            return IDN.toASCII(s, IDN.ALLOW_UNASSIGNED).toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return s.toLowerCase(Locale.ROOT);
        }
    }

    /** The public suffix a host ends in ("com", "co.uk", "k12.co.us"). */
    static String publicSuffix(String host) {
        String h = ascii(host == null ? "" : host.replaceAll("\\.+$", ""));
        String[] labels = h.split("\\.");
        for (int i = 0; i < labels.length; i++) {
            String cand = join(labels, i);
            // (An exception rule is always longer than the wildcard it's an exception to, so it's met first.)
            if (EXCEPT.contains(cand)) return join(labels, i + 1);
            if (RULES.contains(cand)) return cand;
            if (i + 1 < labels.length && WILD.contains(join(labels, i + 1))) return cand;
        }
        return labels[labels.length - 1];
    }

    /** The registrable domain ("school.edu" for "my.school.edu"); the host itself for an IP address or a bare suffix. */
    static String site(String host) {
        String h = ascii(host == null ? "" : host.replaceAll("\\.+$", ""));
        if (h.isEmpty() || h.matches("[0-9.]+") || h.contains(":")) return h;
        String suffix = publicSuffix(h);
        if (h.equals(suffix)) return h;
        String rest = h.substring(0, h.length() - suffix.length() - 1);
        int dot = rest.lastIndexOf('.');
        return (dot < 0 ? rest : rest.substring(dot + 1)) + "." + suffix;
    }

    /** Both hosts are on the same registrable domain (by the public suffix list). */
    static boolean sameSite(String a, String b) {
        String sa = site(a), sb = site(b);
        return !sa.isEmpty() && sa.equals(sb);
    }

    /** An address's host, lowercased ("" when it has none or doesn't parse). */
    static String host(String url) {
        try {
            String h = new URI(url == null ? "" : url.trim()).getHost();
            return h == null ? "" : h.toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return "";
        }
    }

    /** scheme://host[:port], lowercased, without the default port ("" when the address doesn't parse). */
    static String origin(String url) {
        try {
            URI u = new URI(url == null ? "" : url.trim());
            if (u.getScheme() == null || u.getHost() == null) return "";
            String scheme = u.getScheme().toLowerCase(Locale.ROOT);
            int port = u.getPort();
            if ((scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80)) port = -1;
            return scheme + "://" + u.getHost().toLowerCase(Locale.ROOT) + (port == -1 ? "" : ":" + port);
        } catch (Exception e) {
            return "";
        }
    }

    /** An https address with no user info, on exactly one of these hosts. */
    static boolean httpsOn(String url, String... hosts) {
        try {
            URI u = new URI(url == null ? "" : url.trim());
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getRawUserInfo() != null) return false;
            String h = u.getHost().toLowerCase(Locale.ROOT);
            for (String want : hosts) if (want != null && !want.isEmpty() && h.equals(want.toLowerCase(Locale.ROOT))) return true;
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    /** Well-known sign-in services, by their exact host. */
    private static final String[] SIGN_IN_HOSTS = { "login.microsoftonline.com", "login.live.com", "accounts.google.com" };
    /** Sign-in services where each school has its own host (school.okta.com): trusted only on the way from the school's own page. */
    private static final String[] SIGN_IN_TENANTS = { ".okta.com", ".oktapreview.com", ".onelogin.com", ".duosecurity.com" };

    /**
     * Whether a page may be the school's sign-in page, before Kea knows which one it is: the school's own domain (by the
     * public suffix list), a well-known sign-in service, or (only when Kea got there by itself from the school's home
     * page, `fromHome`) the school's own tenant on Okta, OneLogin or Duo.
     */
    static boolean maySignInAt(String pageHost, String homeHost, boolean fromHome) {
        String h = pageHost == null ? "" : pageHost.toLowerCase(Locale.ROOT);
        if (h.isEmpty() || homeHost == null || homeHost.isEmpty()) return false;
        if (sameSite(h, homeHost)) return true;
        for (String s : SIGN_IN_HOSTS) if (h.equals(s)) return true;
        if (fromHome) for (String t : SIGN_IN_TENANTS) if (h.endsWith(t) && h.length() > t.length()) return true;
        return false;
    }

    private static String join(String[] labels, int from) {
        StringBuilder sb = new StringBuilder();
        for (int i = from; i < labels.length; i++) {
            if (sb.length() > 0) sb.append('.');
            sb.append(labels[i]);
        }
        return sb.toString();
    }
}
