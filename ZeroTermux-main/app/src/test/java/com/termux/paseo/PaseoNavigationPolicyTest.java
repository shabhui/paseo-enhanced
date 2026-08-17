package com.termux.paseo;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class PaseoNavigationPolicyTest {

    @Test
    public void allowsOnlyTheEmbeddedPaseoHttpOrigin() {
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_LOCAL,
            PaseoNavigationPolicy.decide("http://127.0.0.1:6767/"));
        assertEquals(PaseoNavigationPolicy.Decision.ALLOW_LOCAL,
            PaseoNavigationPolicy.decide("http://127.0.0.1:6767/session?id=1#output"));

        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("https://127.0.0.1:6767/"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("http://localhost:6767/"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("http://127.0.0.1:6768/"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("http://127.0.0.1:6767.evil.example/"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("https://example.com/"));
    }

    @Test
    public void mapsTheAppOpenLinkToHomeAndBlocksInvalidUrls() {
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_HOME,
            PaseoNavigationPolicy.decide("paseo://open"));
        assertEquals(PaseoNavigationPolicy.Decision.OPEN_HOME,
            PaseoNavigationPolicy.decide("paseo://open/project/123"));

        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("paseo://settings"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide("not a url"));
        assertEquals(PaseoNavigationPolicy.Decision.BLOCK,
            PaseoNavigationPolicy.decide(null));
    }
}
