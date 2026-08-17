package com.termux.zerocore.utils;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

public class BitmapUtils {

    /**
     * 从文件获取 Bitmap（自动处理采样率，避免 OOM）
     */
    public static Bitmap getBitmap(File file) {
        if (file == null || !file.exists() || !file.isFile()) {
            return null;
        }
        return getBitmap(file, 0, 0);
    }

    /**
     * 从文件获取指定尺寸的 Bitmap
     * @param file 图片文件
     * @param reqWidth 期望的宽度，0表示原图
     * @param reqHeight 期望的高度，0表示原图
     */
    public static Bitmap getBitmap(File file, int reqWidth, int reqHeight) {
        if (file == null || !file.exists() || !file.isFile()) {
            return null;
        }

        BitmapFactory.Options options = new BitmapFactory.Options();

        // 如果指定了期望尺寸，先采样
        if (reqWidth > 0 && reqHeight > 0) {
            options.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(file.getAbsolutePath(), options);
            options.inSampleSize = calculateInSampleSize(options, reqWidth, reqHeight);
            options.inJustDecodeBounds = false;
        }

        options.inPreferredConfig = Bitmap.Config.RGB_565; // 节省内存
        options.inDither = false;
        options.inScaled = false;

        try {
            return BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        } catch (OutOfMemoryError e) {
            e.printStackTrace();
            // OOM 时尝试更低的采样率
            options.inSampleSize = options.inSampleSize + 2;
            try {
                return BitmapFactory.decodeFile(file.getAbsolutePath(), options);
            } catch (OutOfMemoryError e2) {
                return null;
            }
        }
    }

    /**
     * 从资源文件获取 Bitmap
     */
    public static Bitmap getBitmap(Context context, int resId) {
        return getBitmap(context, resId, 0, 0);
    }

    /**
     * 从资源文件获取指定尺寸的 Bitmap
     */
    public static Bitmap getBitmap(Context context, int resId, int reqWidth, int reqHeight) {
        if (context == null) {
            return null;
        }

        BitmapFactory.Options options = new BitmapFactory.Options();

        if (reqWidth > 0 && reqHeight > 0) {
            options.inJustDecodeBounds = true;
            BitmapFactory.decodeResource(context.getResources(), resId, options);
            options.inSampleSize = calculateInSampleSize(options, reqWidth, reqHeight);
            options.inJustDecodeBounds = false;
        }

        options.inPreferredConfig = Bitmap.Config.RGB_565;

        try {
            return BitmapFactory.decodeResource(context.getResources(), resId, options);
        } catch (OutOfMemoryError e) {
            e.printStackTrace();
            return null;
        }
    }

    /**
     * 从文件路径获取 Bitmap
     */
    public static Bitmap getBitmap(String filePath) {
        if (filePath == null || filePath.isEmpty()) {
            return null;
        }
        return getBitmap(new File(filePath));
    }

    /**
     * 从 InputStream 获取 Bitmap
     */
    public static Bitmap getBitmap(InputStream inputStream) {
        return getBitmap(inputStream, 0, 0);
    }

    /**
     * 从 InputStream 获取指定尺寸的 Bitmap
     */
    public static Bitmap getBitmap(InputStream inputStream, int reqWidth, int reqHeight) {
        if (inputStream == null) {
            return null;
        }

        try {
            byte[] data = readInputStream(inputStream);
            return getBitmap(data, reqWidth, reqHeight);
        } catch (Exception e) {
            e.printStackTrace();
            return null;
        } finally {
            try {
                inputStream.close();
            } catch (IOException e) {
                e.printStackTrace();
            }
        }
    }

    /**
     * 从字节数组获取 Bitmap
     */
    public static Bitmap getBitmap(byte[] data) {
        return getBitmap(data, 0, 0);
    }

    /**
     * 从字节数组获取指定尺寸的 Bitmap
     */
    public static Bitmap getBitmap(byte[] data, int reqWidth, int reqHeight) {
        if (data == null || data.length == 0) {
            return null;
        }

        BitmapFactory.Options options = new BitmapFactory.Options();

        if (reqWidth > 0 && reqHeight > 0) {
            options.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, options);
            options.inSampleSize = calculateInSampleSize(options, reqWidth, reqHeight);
            options.inJustDecodeBounds = false;
        }

        options.inPreferredConfig = Bitmap.Config.RGB_565;

        try {
            return BitmapFactory.decodeByteArray(data, 0, data.length, options);
        } catch (OutOfMemoryError e) {
            e.printStackTrace();
            return null;
        }
    }

    /**
     * 计算采样率
     */
    private static int calculateInSampleSize(BitmapFactory.Options options,
                                             int reqWidth, int reqHeight) {
        final int height = options.outHeight;
        final int width = options.outWidth;
        int inSampleSize = 1;

        if (height > reqHeight || width > reqWidth) {
            final int halfHeight = height / 2;
            final int halfWidth = width / 2;

            while ((halfHeight / inSampleSize) >= reqHeight
                && (halfWidth / inSampleSize) >= reqWidth) {
                inSampleSize *= 2;
            }
        }

        return inSampleSize;
    }

    /**
     * 读取 InputStream 到字节数组
     */
    private static byte[] readInputStream(InputStream inputStream) throws IOException {
        ByteArrayOutputStream outputStream = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int len;
        while ((len = inputStream.read(buffer)) != -1) {
            outputStream.write(buffer, 0, len);
        }
        return outputStream.toByteArray();
    }

    /**
     * 安全的回收 Bitmap
     */
    public static void recycleBitmap(Bitmap bitmap) {
        if (bitmap != null && !bitmap.isRecycled()) {
            bitmap.recycle();
        }
    }

    /**
     * 保存 Bitmap 到文件
     */
    public static boolean saveBitmap(Bitmap bitmap, File file, Bitmap.CompressFormat format, int quality) {
        if (bitmap == null || file == null) {
            return false;
        }

        FileOutputStream fos = null;
        try {
            fos = new FileOutputStream(file);
            return bitmap.compress(format, quality, fos);
        } catch (FileNotFoundException e) {
            e.printStackTrace();
            return false;
        } finally {
            if (fos != null) {
                try {
                    fos.close();
                } catch (IOException e) {
                    e.printStackTrace();
                }
            }
        }
    }
}
