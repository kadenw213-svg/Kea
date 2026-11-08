package com.kea.scholar;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/**
 * The Kea account's native limits: how long a request may take (background checks are short, nothing waits forever),
 * and the only two places a Google or Microsoft sign-in code is sent. Runs on the PC: gradlew testDebugUnitTest.
 */
public class HubTest {
    @Test
    public void timeLimitsStayBetweenOneSecondAndTheDefault() {
        assertEquals(Hub.CONNECT_MS, Hub.limit(0, Hub.CONNECT_MS));
        assertEquals(4000, Hub.limit(4000, Hub.CONNECT_MS));
        assertEquals(1000, Hub.limit(10, Hub.CONNECT_MS));
        assertEquals(Hub.READ_MS, Hub.limit(10_000_000, Hub.READ_MS));
    }

    @Test
    public void signInCodesGoOnlyToGoogleOrMicrosoft() {
        assertEquals("https://oauth2.googleapis.com/token", Hub.tokenUrl("google"));
        assertEquals("https://login.microsoftonline.com/common/oauth2/v2.0/token", Hub.tokenUrl("microsoft"));
        assertNull(Hub.tokenUrl("https://evil.example/token"));
        assertNull(Hub.tokenUrl(null));
    }
}
