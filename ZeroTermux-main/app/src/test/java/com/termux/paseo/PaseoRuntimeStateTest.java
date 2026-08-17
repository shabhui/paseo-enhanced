package com.termux.paseo;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class PaseoRuntimeStateTest {
    @Test
    public void parsesReadyState() {
        PaseoRuntimeState state = PaseoRuntimeState.parse("ready\nPaseo is ready\n");
        assertEquals(PaseoRuntimeState.Phase.READY, state.phase());
        assertEquals("Paseo is ready", state.message());
    }

    @Test
    public void unknownStateBecomesError() {
        assertEquals(PaseoRuntimeState.Phase.ERROR, PaseoRuntimeState.parse("broken\nOops\n").phase());
    }
}
