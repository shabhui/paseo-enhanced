package com.termux.zerocore.ai.llm.utils;

import com.example.xh_lib.utils.UUtils;
import com.termux.R;

public class CodeStringUtils {
    public static String getCodeString(int code) {
        switch (code) {
            case 400:
                return UUtils.getString(R.string.deepseek_input_key_error_info_400);
            case 401:
                return UUtils.getString(R.string.deepseek_input_key_error_info_401);
            case 402:
                return UUtils.getString(R.string.deepseek_input_key_error_info_402);
            case 403:
                return UUtils.getString(R.string.deepseek_input_key_error_info_403);
            case 422:
                return UUtils.getString(R.string.deepseek_input_key_error_info_422);
            case 429:
                return UUtils.getString(R.string.deepseek_input_key_error_info_429);
            case 500:
                return UUtils.getString(R.string.deepseek_input_key_error_info_500);
            case 503:
                return UUtils.getString(R.string.deepseek_input_key_error_info_503);
            default:
                return UUtils.getString(R.string.deepseek_input_key_error_info_other);
        }
    }
}
