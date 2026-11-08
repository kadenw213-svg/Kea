package com.kea.scholar;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Arrays;

import org.junit.Test;

/**
 * The native side of Work's organization servers (Orgs.java): which addresses passes may go to, base64url, the server
 * id from its key, the Ed25519 identity check (with the JDK's Ed25519 standing in for Android 13's), and that only a
 * pass made for a server is kept for it. Runs on the PC: gradlew testDebugUnitTest.
 */
public class OrgsTest {
    @Test
    public void addressesAreHttpsOrThisPhoneOnly() {
        assertEquals("https://pool.example.org", Orgs.cleanUrl("https://Pool.Example.org/v1/x"));
        assertEquals("https://pool.example.org:8443", Orgs.cleanUrl("https://pool.example.org:8443"));
        assertEquals("https://pool.example.org", Orgs.cleanUrl("https://pool.example.org:443"));
        assertEquals("http://127.0.0.1:9000", Orgs.cleanUrl("http://127.0.0.1:9000"));
        assertNull(Orgs.cleanUrl("http://pool.example.org"));
        assertNull(Orgs.cleanUrl("ftp://pool.example.org"));
        assertNull(Orgs.cleanUrl("https://me:pw@pool.example.org"));
        assertNull(Orgs.cleanUrl("kea://join?s=x"));
        assertNull(Orgs.cleanUrl(null));
    }

    @Test
    public void onlyOrgApiPaths() {
        assertTrue(Orgs.pathOk("/v1/orgs/abc/clock"));
        assertFalse(Orgs.pathOk("/v1/../owner"));
        assertFalse(Orgs.pathOk("/admin"));
        assertFalse(Orgs.pathOk("/v1/orgs\r\nHost: x"));
        assertFalse(Orgs.pathOk(null));
    }

    @Test
    public void base64urlRoundTrips() {
        for (int n = 0; n < 70; n++) {
            byte[] b = new byte[n];
            for (int i = 0; i < n; i++) b[i] = (byte) (i * 37 + n);
            String s = Orgs.b64url(b);
            assertFalse(s.contains("=") || s.contains("+") || s.contains("/"));
            assertArrayEquals(b, Orgs.unb64url(s));
            assertEquals(java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b), s);
        }
        assertEquals(0, Orgs.unb64url("not base64!").length);
        assertArrayEquals(new byte[] { (byte) 0xfb, (byte) 0xff }, Orgs.unb64url("+/8="));
    }

    private static byte[] rawKey(KeyPair kp) {
        byte[] enc = kp.getPublic().getEncoded();
        return Arrays.copyOfRange(enc, enc.length - 32, enc.length);
    }

    private static String sign(KeyPair kp, String text) throws Exception {
        Signature s = Signature.getInstance("Ed25519");
        s.initSign(kp.getPrivate());
        s.update(text.getBytes(StandardCharsets.UTF_8));
        return Orgs.b64url(s.sign());
    }

    @Test
    public void identityIsCheckedWithEd25519AndTheIdIsBoundToTheKey() throws Exception {
        KeyPair kp = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        byte[] raw = rawKey(kp);
        assertArrayEquals(kp.getPublic().getEncoded(), Orgs.spki(raw));
        String x = Orgs.b64url(raw);
        String id = Orgs.serverIdOf(raw);
        assertEquals(22, id.length());
        String sig = sign(kp, "kea-server-identity:" + id + ":n1");
        assertEquals("ok", Orgs.verifyIdentity("OKP", "Ed25519", x, id, sig, "n1"));
        // Another nonce, another id, another key, a broken signature or key: refused.
        assertEquals("bad", Orgs.verifyIdentity("OKP", "Ed25519", x, id, sig, "n2"));
        assertEquals("bad", Orgs.verifyIdentity("OKP", "Ed25519", x, "AAAAAAAAAAAAAAAAAAAAAA", sig, "n1"));
        KeyPair other = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        assertEquals("bad", Orgs.verifyIdentity("OKP", "Ed25519", Orgs.b64url(rawKey(other)), id, sig, "n1"));
        assertEquals("bad", Orgs.verifyIdentity("OKP", "Ed25519", x, id, sig.substring(0, 40), "n1"));
        assertEquals("bad", Orgs.verifyIdentity("OKP", "Ed25519", x.substring(2), id, sig, "n1"));
        assertEquals("bad", Orgs.verifyIdentity("EC", "P-256", x, id, sig, "n1"));
        assertEquals(Boolean.TRUE, Orgs.ed25519(raw, ("kea-server-identity:" + id + ":n1").getBytes(StandardCharsets.UTF_8), Orgs.unb64url(sig)));
    }

    @Test
    public void onlyAPassForThisServerIsKept() {
        String id = "abcdefghijklmnopqrstuv";
        assertTrue(Orgs.audFor("keas:" + id, id));
        assertFalse(Orgs.audFor("keas:AAAAAAAAAAAAAAAAAAAAAA", id));
        assertFalse(Orgs.audFor("keac-org:" + id, id));
        assertFalse(Orgs.audFor("keas:" + id, "short"));
        assertFalse(Orgs.audFor("keas:", ""));
        assertFalse(Orgs.audFor("keas:" + id, null));
        assertEquals(1_700_000_000_000L, Orgs.asMs(1_700_000_000));
        assertEquals(1_700_000_000_000L, Orgs.asMs(1_700_000_000_000d));
        assertEquals(0, Orgs.asMs(0));
    }
}
