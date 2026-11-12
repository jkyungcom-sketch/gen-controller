package org.jkyung.generator;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

/**
 * MainActivity — Capacitor BridgeActivity 확장.
 *
 * 역할:
 *  1) WebView 에 window.AndroidWifiBridge 자바 브릿지를 주입
 *     (관리자 페이지 index.html 의 V3.0 Wi-Fi 계약 구현)
 *  2) 발전기 Wi-Fi 스캔/연결에 필요한 런타임 권한 요청 진입점 제공
 *  3) 브릿지가 연결/해제 이벤트를 JS 로 되돌려 줄 수 있게 콜백 제공
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "MainActivity";
    private static final int REQ_WIFI_PERMS = 4201;

    private AndroidWifiBridge wifiBridge = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        try {
            WebView wv = getBridge().getWebView();
            WebSettings ws = wv.getSettings();
            ws.setJavaScriptEnabled(true);
            ws.setDomStorageEnabled(true);
            // http://192.168.4.1 (ESP32 AP) 평문 통신 허용
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                WebView.setWebContentsDebuggingEnabled(true);
            }

            wifiBridge = new AndroidWifiBridge(this);
            wv.addJavascriptInterface(wifiBridge, "AndroidWifiBridge");
            Log.i(TAG, "AndroidWifiBridge 주입 완료");
        } catch (Throwable t) {
            Log.e(TAG, "브릿지 주입 실패", t);
        }

        ensureWifiPermissions();
    }

    /** Wi-Fi 스캔/연결에 필요한 런타임 권한 요청 (이미 있으면 즉시 반환). */
    public void ensureWifiPermissions() {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;

            java.util.List<String> need = new java.util.ArrayList<String>();

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                if (ContextCompat.checkSelfPermission(this, "android.permission.NEARBY_WIFI_DEVICES")
                        != PackageManager.PERMISSION_GRANTED) {
                    need.add("android.permission.NEARBY_WIFI_DEVICES");
                }
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                    != PackageManager.PERMISSION_GRANTED) {
                need.add(Manifest.permission.ACCESS_FINE_LOCATION);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
                        != PackageManager.PERMISSION_GRANTED) {
                    need.add(Manifest.permission.BLUETOOTH_CONNECT);
                }
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN)
                        != PackageManager.PERMISSION_GRANTED) {
                    need.add(Manifest.permission.BLUETOOTH_SCAN);
                }
            }

            if (need.isEmpty()) {
                Log.i(TAG, "권한 이미 모두 승인됨");
                return;
            }
            ActivityCompat.requestPermissions(this,
                    need.toArray(new String[0]), REQ_WIFI_PERMS);
            Log.i(TAG, "권한 요청: " + need);
        } catch (Throwable t) {
            Log.e(TAG, "권한 요청 실패", t);
        }
    }

    // ── 브릿지 → JS 이벤트 콜백 ─────────────────────────────────
    public void onWifiBridgeConnected(final String ssid) {
        evalJs("window.dispatchEvent(new CustomEvent('androidWifiConnected',{detail:{ssid:" + jsStr(ssid) + "}}));");
    }

    public void onWifiBridgeDisconnected(final String ssid) {
        evalJs("window.dispatchEvent(new CustomEvent('androidWifiDisconnected',{detail:{ssid:" + jsStr(ssid) + "}}));");
    }

    /** ★ 연결/바인딩 실패를 JS 로 알린다 (UI 침몰 방지) */
    public void onWifiBridgeFailed(final String ssid, final String reason) {
        evalJs("window.dispatchEvent(new CustomEvent('androidWifiFailed',{detail:{ssid:"
                + jsStr(ssid) + ",reason:" + jsStr(reason) + "}}));");
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void evalJs(final String js) {
        try {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        getBridge().getWebView().evaluateJavascript(js, null);
                    } catch (Throwable t) {
                        Log.w(TAG, "evaluateJavascript 실패", t);
                    }
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "evalJs 실패", t);
        }
    }

    private static String jsStr(String s) {
        if (s == null) return "null";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    @Override
    public void onDestroy() {
        try {
            if (wifiBridge != null) {
                wifiBridge.destroy();
                wifiBridge = null;
            }
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }
}
