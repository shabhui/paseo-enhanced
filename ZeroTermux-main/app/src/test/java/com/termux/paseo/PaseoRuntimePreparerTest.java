package com.termux.paseo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.ArrayDeque;
import java.util.Queue;
import java.util.concurrent.Executor;

import org.junit.Test;

public class PaseoRuntimePreparerTest {

    @Test
    public void preparationRunsOnTheWorkerBeforeSuccessReturnsToTheCallbackExecutor() {
        QueueExecutor worker = new QueueExecutor();
        QueueExecutor callbacks = new QueueExecutor();
        PaseoRuntimePreparer preparer = new PaseoRuntimePreparer(worker, callbacks);
        boolean[] installed = {false};
        boolean[] completed = {false};

        preparer.prepare(() -> installed[0] = true, () -> completed[0] = true, error -> { });

        assertFalse(installed[0]);
        assertFalse(completed[0]);
        assertEquals(1, worker.size());

        worker.runNext();

        assertTrue(installed[0]);
        assertFalse(completed[0]);
        assertEquals(1, callbacks.size());

        callbacks.runNext();
        assertTrue(completed[0]);
    }

    @Test
    public void failureReturnsToTheCallbackExecutorWithoutRunningSuccess() {
        QueueExecutor worker = new QueueExecutor();
        QueueExecutor callbacks = new QueueExecutor();
        PaseoRuntimePreparer preparer = new PaseoRuntimePreparer(worker, callbacks);
        Exception failure = new Exception("copy failed");
        Exception[] reported = {null};
        boolean[] completed = {false};

        preparer.prepare(() -> { throw failure; }, () -> completed[0] = true, error -> reported[0] = error);
        worker.runNext();

        assertFalse(completed[0]);
        assertEquals(1, callbacks.size());

        callbacks.runNext();
        assertSame(failure, reported[0]);
        assertFalse(completed[0]);
    }

    private static final class QueueExecutor implements Executor {
        private final Queue<Runnable> tasks = new ArrayDeque<>();

        @Override
        public void execute(Runnable command) {
            tasks.add(command);
        }

        int size() {
            return tasks.size();
        }

        void runNext() {
            tasks.remove().run();
        }
    }
}
