package com.termux.paseo;

import java.util.concurrent.Executor;

final class PaseoRuntimePreparer {
    interface Operation {
        void run() throws Exception;
    }

    interface FailureHandler {
        void onFailure(Exception error);
    }

    private final Executor workerExecutor;
    private final Executor callbackExecutor;

    PaseoRuntimePreparer(Executor workerExecutor, Executor callbackExecutor) {
        this.workerExecutor = workerExecutor;
        this.callbackExecutor = callbackExecutor;
    }

    void prepare(Operation operation, Runnable onSuccess, FailureHandler onFailure) {
        workerExecutor.execute(() -> {
            try {
                operation.run();
                callbackExecutor.execute(onSuccess);
            } catch (Exception error) {
                callbackExecutor.execute(() -> onFailure.onFailure(error));
            }
        });
    }
}
