package com.termux.paseo;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.res.AssetManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import com.termux.app.TermuxInstaller;
import com.termux.app.TermuxService;
import com.termux.shared.termux.TermuxConstants;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class PaseoRuntimeController implements ServiceConnection {
    public interface Listener {
        void onState(PaseoRuntimeState state);
    }

    private static final long STATUS_POLL_MS = 500L;
    private static final ExecutorService RUNTIME_INSTALL_EXECUTOR = Executors.newSingleThreadExecutor(command -> {
        Thread thread = new Thread(command, "paseo-runtime-installer");
        thread.setDaemon(true);
        return thread;
    });

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final PaseoAssetInstaller assetInstaller = new PaseoAssetInstaller();
    private final PaseoRuntimePreparer runtimePreparer = new PaseoRuntimePreparer(
        RUNTIME_INSTALL_EXECUTOR, command -> handler.post(command));
    private Activity activity;
    private Listener listener;
    private TermuxService service;
    private boolean serviceBound;
    private boolean finished;
    private long runGeneration;
    private String currentRunId;

    private final Runnable statusPoll = new Runnable() {
        @Override
        public void run() {
            if (finished) return;
            PaseoRuntimeState state = readState();
            dispatch(state);
            if (state.phase() != PaseoRuntimeState.Phase.READY &&
                state.phase() != PaseoRuntimeState.Phase.ERROR) {
                handler.postDelayed(this, STATUS_POLL_MS);
            }
        }
    };

    public void start(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
        this.finished = false;
        this.runGeneration++;
        this.currentRunId = null;
        dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING, "Preparing the embedded terminal"));

        Intent intent = new Intent(activity, TermuxService.class);
        try {
            activity.startService(intent);
            serviceBound = activity.bindService(intent, this, Context.BIND_AUTO_CREATE);
            if (!serviceBound) {
                dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.ERROR, "Unable to bind the embedded terminal service"));
            }
        } catch (Exception error) {
            dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.ERROR, messageFor(error)));
        }
    }

    public void retry() {
        if (activity == null || listener == null) return;
        Activity currentActivity = activity;
        Listener currentListener = listener;
        stop();
        start(currentActivity, currentListener);
    }

    public void stop() {
        finished = true;
        runGeneration++;
        currentRunId = null;
        handler.removeCallbacks(statusPoll);
        if (serviceBound && activity != null) {
            try {
                activity.unbindService(this);
            } catch (Exception ignored) {
                // The activity may already be finishing.
            }
        }
        serviceBound = false;
        service = null;
        activity = null;
        listener = null;
    }

    @Override
    public void onServiceConnected(ComponentName name, IBinder binder) {
        service = TermuxService.fromBinder(binder);
        if (service == null || activity == null) {
            dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.ERROR, "Embedded terminal service returned an invalid binder"));
            return;
        }
        long generation = runGeneration;
        TermuxInstaller.setupBootstrapIfNeeded(activity, () -> launchPaseoScript(generation));
    }

    @Override
    public void onServiceDisconnected(ComponentName name) {
        service = null;
        runGeneration++;
        currentRunId = null;
        if (!finished) {
            dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.ERROR, "Embedded terminal service disconnected"));
        }
    }

    private void launchPaseoScript(long generation) {
        if (!isCurrentRun(generation) || activity == null || service == null) return;

        AssetManager assets = activity.getApplicationContext().getAssets();
        File runtimeDirectory = new File(TermuxConstants.TERMUX_HOME_DIR_PATH, ".paseo-app/runtime");
        dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING, "Installing the embedded Paseo runtime"));
        runtimePreparer.prepare(
            () -> assetInstaller.install(assets, "paseo-runtime", runtimeDirectory),
            () -> startPaseoTask(generation, runtimeDirectory),
            error -> {
                if (isCurrentRun(generation)) {
                    dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.ERROR, messageFor(error)));
                }
            });
    }

    private void startPaseoTask(long generation, File runtimeDirectory) {
        if (!isCurrentRun(generation) || service == null) return;

        try {
            File script = new File(runtimeDirectory, "start-paseo.sh");
            script.setExecutable(true, true);
            String runId = UUID.randomUUID().toString();
            currentRunId = runId;
            if (service.createTermuxTask(
                TermuxConstants.TERMUX_BIN_PREFIX_DIR_PATH + "/bash",
                new String[]{script.getAbsolutePath(), runId}, null,
                TermuxConstants.TERMUX_HOME_DIR_PATH) == null) {
                currentRunId = null;
                dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.ERROR, "Unable to start the Paseo bootstrap script"));
                return;
            }
            handler.removeCallbacks(statusPoll);
            handler.post(statusPoll);
        } catch (Exception error) {
            currentRunId = null;
            dispatch(new PaseoRuntimeState(PaseoRuntimeState.Phase.ERROR, messageFor(error)));
        }
    }

    private PaseoRuntimeState readState() {
        String expectedRunId = currentRunId;
        if (expectedRunId == null) {
            return new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING, "Waiting for the embedded runtime");
        }
        File statusFile = new File(
            TermuxConstants.TERMUX_HOME_DIR_PATH,
            ".paseo-app/status-" + expectedRunId);
        if (!statusFile.isFile()) {
            return new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING, "Installing the embedded Paseo runtime");
        }
        StringBuilder contents = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
            new FileInputStream(statusFile), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (contents.length() > 0) contents.append('\n');
                contents.append(line);
            }
            return PaseoRunStatus.parse(expectedRunId, contents.toString());
        } catch (IOException error) {
            return new PaseoRuntimeState(PaseoRuntimeState.Phase.INSTALLING, "Waiting for the embedded runtime");
        }
    }

    private boolean isCurrentRun(long generation) {
        return !finished && generation == runGeneration;
    }

    private void dispatch(PaseoRuntimeState state) {
        if (listener != null) listener.onState(state);
    }

    private static String messageFor(Exception error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message;
    }
}
