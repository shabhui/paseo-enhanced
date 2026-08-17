package com.termux.paseo;

import static org.junit.Assert.assertEquals;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class PaseoRuntimeControllerTest {

    @Test
    public void retryUnbindsBeforeBindingAgain() {
        RecordingActivity activity = new RecordingActivity();
        PaseoRuntimeController controller = new PaseoRuntimeController();

        controller.start(activity, state -> { });
        controller.retry();

        assertEquals(2, activity.bindCalls);
        assertEquals(1, activity.unbindCalls);
        controller.stop();
    }

    private static final class RecordingActivity extends Activity {
        int bindCalls;
        int unbindCalls;

        @Override
        public String getPackageName() {
            return "com.termux";
        }

        @Override
        public ComponentName startService(Intent service) {
            return service.getComponent();
        }

        @Override
        public boolean bindService(Intent service, ServiceConnection connection, int flags) {
            bindCalls++;
            return true;
        }

        @Override
        public void unbindService(ServiceConnection connection) {
            unbindCalls++;
        }
    }
}
