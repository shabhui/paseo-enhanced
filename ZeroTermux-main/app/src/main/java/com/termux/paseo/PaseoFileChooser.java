package com.termux.paseo;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebChromeClient;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

final class PaseoFileChooser {
    private PaseoFileChooser() {}

    static Intent createIntent(String[] acceptTypes, int mode) {
        String[] normalizedTypes = normalizeAcceptTypes(acceptTypes);
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
            mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
        if (normalizedTypes.length == 1) {
            intent.setType(normalizedTypes[0]);
        } else {
            intent.setType("*/*");
            if (normalizedTypes.length > 1) {
                intent.putExtra(Intent.EXTRA_MIME_TYPES, normalizedTypes);
            }
        }
        return intent;
    }

    static Uri[] parseResult(int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null) return null;
        ClipData clipData = data.getClipData();
        if (clipData != null && clipData.getItemCount() > 0) {
            Uri[] results = new Uri[clipData.getItemCount()];
            for (int index = 0; index < clipData.getItemCount(); index++) {
                results[index] = clipData.getItemAt(index).getUri();
            }
            return results;
        }
        Uri result = data.getData();
        return result == null ? null : new Uri[]{result};
    }

    private static String[] normalizeAcceptTypes(String[] acceptTypes) {
        Set<String> types = new LinkedHashSet<>();
        if (acceptTypes != null) {
            for (String acceptType : acceptTypes) {
                if (acceptType == null) continue;
                for (String candidate : acceptType.split(",")) {
                    String value = candidate.trim();
                    if (!value.isEmpty() && value.contains("/")) types.add(value);
                }
            }
        }
        List<String> result = new ArrayList<>(types);
        return result.toArray(new String[0]);
    }
}
