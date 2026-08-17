package com.termux.paseo;

import java.net.URI;

final class PaseoNavigationPolicy {
    enum Decision {
        ALLOW_LOCAL,
        OPEN_HOME,
        BLOCK
    }

    private static final String LOCAL_SCHEME = "http";
    private static final String LOCAL_HOST = "127.0.0.1";
    private static final int LOCAL_PORT = 6767;

    private PaseoNavigationPolicy() {
    }

    static Decision decide(String url) {
        if (url == null) return Decision.BLOCK;

        final URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException error) {
            return Decision.BLOCK;
        }

        String scheme = uri.getScheme();
        String host = uri.getHost();
        if ("paseo".equalsIgnoreCase(scheme) && "open".equalsIgnoreCase(host)) {
            return Decision.OPEN_HOME;
        }
        if (LOCAL_SCHEME.equalsIgnoreCase(scheme) && LOCAL_HOST.equals(host) && uri.getPort() == LOCAL_PORT) {
            return Decision.ALLOW_LOCAL;
        }
        return Decision.BLOCK;
    }
}
