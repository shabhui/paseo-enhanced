package com.termux.paseo;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebChromeClient;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class PaseoFileChooserTest {

    @Test
    public void createsAnOpenDocumentIntentForImagesAndAttachments() {
        Intent intent = PaseoFileChooser.createIntent(
            new String[]{"image/*", "application/pdf"},
            WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);

        assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.getAction());
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals("*/*", intent.getType());
        assertArrayEquals(new String[]{"image/*", "application/pdf"},
            intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES));
        assertTrue(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
    }

    @Test
    public void returnsEverySelectedAttachmentToTheWebView() {
        Intent data = new Intent();
        Uri first = Uri.parse("content://files/image.png");
        Uri second = Uri.parse("content://files/notes.txt");
        ClipData clipData = ClipData.newUri(
            org.robolectric.RuntimeEnvironment.getApplication().getContentResolver(),
            "files",
            first);
        clipData.addItem(new ClipData.Item(second));
        data.setClipData(clipData);

        assertArrayEquals(new Uri[]{first, second},
            PaseoFileChooser.parseResult(Activity.RESULT_OK, data));
    }
}
