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

        // ★ 소비자는 아무 설정도 건드리지 않는다. 앱을 켜면 즉시 권한 팝업.
        //   (창이 실제로 뜬 뒤에 요청해야 안드로이드가 다이얼로그를 보여준다)
        getWindow().getDecorView().post(new Runnable() {
            @Override
            public void run() {
                getWindow().getDecorView().postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        ensureWifiPermissions();
                    }
                }, 400);
            }
        });
    }

    /** 권한 팝업 결과 → 거부돼도 앱은 살아 있게, 재요청 경로 제공. */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_WIFI_PERMS) return;

        int granted = 0;
        int denied = 0;
        StringBuilder deniedList = new StringBuilder();
        for (int i = 0; i < grantResults.length; i++) {
            if (grantResults[i] == PackageManager.PERMISSION_GRANTED) {
                granted++;
            } else {
                denied++;
                if (i < permissions.length) {
                    deniedList.append(permissions[i]).append(' ');
                }
            }
        }
        Log.i(TAG, "권한 결과: 허용 " + granted + " / 거부 " + denied
                + (denied > 0 ? (" [" + deniedList + "]") : ""));

        // 거부된 게 있으면 JS 에 알려서 UI 가 안내 문구를 띄울 수 있게 한다
        if (denied > 0) {
            evalJs("window.dispatchEvent(new CustomEvent('androidPermsDenied',{detail:{"
                    + "denied:\"" + deniedList.toString().trim() + "\"}}));");
        } else {
            evalJs("window.dispatchEvent(new CustomEvent('androidPermsGranted',{detail:{}}));");
        }
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
            // ★ 위치 권한은 Android 12+ 에서도 SSID 스캔에 필수
            //   (FINE 만 요청하면 일부 기기에서 COARSE 가 자동 거부되어 SSID 가 <unknown ssid>)
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                    != PackageManager.PERMISSION_GRANTED) {
                need.add(Manifest.permission.ACCESS_FINE_LOCATION);
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
                    != PackageManager.PERMISSION_GRANTED) {
                need.add(Manifest.permission.ACCESS_COARSE_LOCATION);
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
