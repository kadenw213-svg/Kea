package com.kea.scholar;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.FileInputStream;

import org.junit.BeforeClass;
import org.junit.Test;

/**
 * Where the phone's saved school login may be typed, where the school session may be sent, and when a Kea Hub address
 * counts as a different Hub (Domains, Hub.sameHub). Runs on the PC: gradlew testReleaseUnitTest.
 */
public class DomainsTest {
    @BeforeClass
    public static void load() throws Exception {
        try (FileInputStream in = new FileInputStream("src/main/res/raw/public_suffixes.txt")) {
            Domains.load(in);
        }
    }

    @Test
    public void registrableDomainsFollowThePublicSuffixList() {
        assertEquals("school.edu", Domains.site("mycourses.school.edu"));
        assertEquals("school.edu", Domains.site("school.edu"));
        assertEquals("bbc.co.uk", Domains.site("www.bbc.co.uk"));
        // A two-label guess would make every Colorado K-12 district one site: the list knows k12.co.us is a suffix.
        assertEquals("district.k12.co.us", Domains.site("lms.district.k12.co.us"));
        assertEquals("co.us", Domains.publicSuffix("co.us"));
        // Wildcard and exception rules (*.ck, !www.ck).
        assertEquals("a.b.ck", Domains.site("x.a.b.ck"));
        assertEquals("www.ck", Domains.site("www.ck"));
        // Shared class-site services: each school's own host is its site.
        assertEquals("cccs.instructure.com", Domains.site("cccs.instructure.com"));
        assertEquals("school.brightspace.com", Domains.site("x.school.brightspace.com"));
        // Private suffixes (anyone can have a github.io site).
        assertEquals("evil.github.io", Domains.site("evil.github.io"));
    }

    @Test
    public void theLoginIsOnlyTypedOnTheSchoolsOwnSignInPages() {
        String home = "mycourses.cccs.edu";
        assertTrue(Domains.maySignInAt("sso.cccs.edu", home, false));
        assertTrue(Domains.maySignInAt("login.microsoftonline.com", home, false));
        assertTrue(Domains.maySignInAt("accounts.google.com", home, false));
        assertFalse(Domains.maySignInAt("cccs.edu.evil.com", home, true));
        assertFalse(Domains.maySignInAt("evilcccs.edu", home, true));
        assertFalse(Domains.maySignInAt("login.microsoftonline.com.evil.com", home, true));
        // Tenant sign-in services only on the way from the school's own home page.
        assertFalse(Domains.maySignInAt("attacker.okta.com", home, false));
        assertTrue(Domains.maySignInAt("cccs.okta.com", home, true));
        assertFalse(Domains.maySignInAt("okta.com", home, true));
        // Another district under the same state suffix, another school on the same Canvas: not the school.
        assertFalse(Domains.maySignInAt("other.k12.co.us", "lms.district.k12.co.us", true));
        assertTrue(Domains.maySignInAt("sso.district.k12.co.us", "lms.district.k12.co.us", false));
        assertFalse(Domains.maySignInAt("evil.instructure.com", "cccs.instructure.com", true));
        assertFalse(Domains.maySignInAt("sso.cccs.edu", "", true));
    }

    @Test
    public void theSchoolSessionOnlyGoesToTheClassSiteOverHttps() {
        String home = "mycourses.cccs.edu", login = "sso.cccs.edu";
        assertTrue(Domains.httpsOn("https://mycourses.cccs.edu/d2l/api/lp/1.0/users/whoami", home, login));
        assertTrue(Domains.httpsOn("https://SSO.cccs.edu/x", home, login));
        assertFalse(Domains.httpsOn("http://mycourses.cccs.edu/x", home, login));
        assertFalse(Domains.httpsOn("https://evil.example/x", home, login));
        assertFalse(Domains.httpsOn("https://mycourses.cccs.edu.evil.example/x", home, login));
        assertFalse(Domains.httpsOn("https://mycourses.cccs.edu@evil.example/x", home, login));
        assertFalse(Domains.httpsOn("https://evil.example/@mycourses.cccs.edu", home, login));
        assertFalse(Domains.httpsOn("file:///data/data/com.kea.scholar/shared_prefs/kea.xml", home, login));
        assertFalse(Domains.httpsOn("javascript:alert(1)", home, login));
        assertFalse(Domains.httpsOn("https://other.cccs.edu/x", home, ""));
        assertFalse(Domains.httpsOn(null, home, login));
    }

    @Test
    public void aDifferentHubIsADifferentOrigin() {
        assertTrue(Hub.sameHub("https://kea.example.ts.net", "https://KEA.example.ts.net/"));
        assertTrue(Hub.sameHub("https://kea.example.ts.net", "https://kea.example.ts.net:443"));
        assertFalse(Hub.sameHub("https://kea.example.ts.net", "https://evil.example"));
        assertFalse(Hub.sameHub("https://kea.example.ts.net", "https://kea.example.ts.net:8443"));
        assertFalse(Hub.sameHub("https://kea.example.ts.net", "http://kea.example.ts.net"));
        assertFalse(Hub.sameHub("", "https://kea.example.ts.net"));
        assertFalse(Hub.sameHub("https://kea.example.ts.net", "https://kea.example.ts.net.evil.example"));
    }

    @Test
    public void relativePathsStayInsideTheirFolder() {
        assertTrue(KeaPlugin.plainRel("kea-data.json"));
        assertTrue(KeaPlugin.plainRel("Textbooks/BIO1112/x.pdf"));
        assertFalse(KeaPlugin.plainRel("../shared_prefs/kea.xml"));
        assertFalse(KeaPlugin.plainRel("Textbooks/../../x"));
        assertFalse(KeaPlugin.plainRel("/data/data/com.kea.scholar/x"));
        assertFalse(KeaPlugin.plainRel("a//b"));
        assertFalse(KeaPlugin.plainRel("a\\..\\b"));
        assertFalse(KeaPlugin.plainRel(""));
    }
}
