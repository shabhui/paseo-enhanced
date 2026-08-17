package com.termux.paseo;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class PaseoRunStatusTest {

    @Test
    public void acceptsReadyOnlyWhenTheStatusMatchesTheCurrentRun() {
        PaseoRuntimeState matching = PaseoRunStatus.parse("run-new", "run-new\nready\nPaseo is ready");
        PaseoRuntimeState stale = PaseoRunStatus.parse("run-new", "run-old\nready\nPaseo is ready");
        PaseoRuntimeState legacy = PaseoRunStatus.parse("run-new", "ready\nPaseo is ready");

        assertEquals(PaseoRuntimeState.Phase.READY, matching.phase());
        assertEquals(PaseoRuntimeState.Phase.INSTALLING, stale.phase());
        assertEquals(PaseoRuntimeState.Phase.INSTALLING, legacy.phase());
    }

    @Test
    public void parsesErrorsFromTheCurrentRun() {
        PaseoRuntimeState state = PaseoRunStatus.parse("run-1", "run-1\nerror\nRuntime installation failed");

        assertEquals(PaseoRuntimeState.Phase.ERROR, state.phase());
        assertEquals("Runtime installation failed", state.message());
    }
}
