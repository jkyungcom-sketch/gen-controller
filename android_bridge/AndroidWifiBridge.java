package org.jkyung.generator;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.NetworkRequest;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * AndroidWifiBridge — 관리자 페이지(index.html)의 window.AndroidWifiBridge 계약 구현.
 *
 * 계약:
 *   requestPermissions()              : Wi-Fi/위치 권한 요청 (void)
 *   scanGenerators()                  : JSON 배열 문자열 [{ssid, rssi}] (동기 반환)
 *   connectAndBindWifi(ssid, pin)     : 발전기 AP 접속 + bindProcessToNetwork (void, 비동기 수행)
 *   unbindWifi()                      : 바인딩 해제 (void)
 *
 * 동기 반환이 필요한 scanGenerators 는 (a) 즉시 캐시 반환 → (b) 백그라운드 재스캔 요청.
 * JS 가 런타임에 window.AndroidWifiBridge 만 재확인하면 되므로 별도 폴링 불필요.
 */
public class AndroidWifiBridge {

    private static final String TAG = "AndroidWifiBridge";
    private static final String SSID_PREFIX = "JKYUNG_";
    private static final long SCAN_TIMEOUT_MS = 6000L;

    /** 최근 스캔 캐시. 연결 성공 시에도 갱신. */
    private final List<String[]> cache = Collections.synchronizedList(new ArrayList<String[]>());

    private final MainActivity activity;
    private final Handler main = new Handler(Looper.getMainLooper());

    private ConnectivityManager connMgr;
    private WifiManager wifiMgr;

    /** 현재 바인딩된 발전기 네트워크 */
    private Network boundNetwork = null;
    private ConnectivityManager.NetworkCallback netCb = null;

    private BroadcastReceiver scanReceiver = null;
    private int cachedRssi = -127;

    public AndroidWifiBridge(MainActivity activity) {
        this.activity = activity;
    }

    private ConnectivityManager cm() {
        if (connMgr == null) {
            connMgr = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
        }
        return connMgr;
    }

    @SuppressWarnings("deprecation")
    private WifiManager wm() {
        if (wifiMgr == null) {
            wifiMgr = (WifiManager) activity.getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
        }
        return wifiMgr;
    }

    // ==================================================================
    // 1) requestPermissions
    // ==================================================================
    @JavascriptInterface
    public void requestPermissions() {
        Log.i(TAG, "requestPermissions()");
        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    activity.ensureWifiPermissions();
                } catch (Throwable t) {
                    Log.e(TAG, "권한 요청 실패", t);
                }
            }
        });
    }

    private boolean hasScanPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // API 33+ : 위치 권한 없이도 Wi-Fi 스캔 가능 (NEARBY_WIFI_DEVICES 승인 시)
            if (ContextCompat.checkSelfPermission(activity, "android.permission.NEARBY_WIFI_DEVICES")
                    == PackageManager.PERMISSION_GRANTED) {
                return true;
            }
        }
        return ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    // ==================================================================
    // 2) scanGenerators — JS 로 "동기 문자열" 반환 (핵심 제약)
    //    방법: (a) 현재 캐시를 즉시 반환. (b) 캐시가 없으면
    //          WifiManager.getScanResults() (마지막 시스템 스캔 결과) 동기 조회.
    //          (c) 동시에 startScan() 을 백그라운드로 던져 다음 호출을 준비.
    // ==================================================================
    @JavascriptInterface
    public String scanGenerators() {
        Log.i(TAG, "scanGenerators()");
        try {
            if (!hasScanPermission()) {
                Log.w(TAG, "스캔 권한 없음 — 빈 배열 반환");
                return "[]";
            }

            // (b) 시스템의 마지막 스캔 결과를 동기적으로 읽는다 (API 100% 동기)
            List<ScanResult> results = null;
            try {
                results = wm().getScanResults();
            } catch (SecurityException se) {
                Log.w(TAG, "getScanResults 권한 예외", se);
            }

            // (c) 다음 번을 위해 백그라운드 스캔 트리거 (결과는 비동기로 도착)
            kickScan();

            if (results == null || results.isEmpty()) {
                return dumpCache();
            }

            List<String[]> items = new ArrayList<String[]>();
            int selfRssi = -127;
            for (ScanResult r : results) {
                if (r == null || r.SSID == null) continue;
                if (!r.SSID.startsWith(SSID_PREFIX)) continue;
                items.add(new String[]{r.SSID, String.valueOf(r.level)});
                if (r.level > selfRssi) selfRssi = r.level;
            }
            cachedRssi = selfRssi;

            if (items.isEmpty()) {
                return dumpCache();
            }

            Collections.sort(items, new Comparator<String[]>() {
                @Override
                public int compare(String[] a, String[] b) {
                    return Integer.parseInt(b[1]) - Integer.parseInt(a[1]);
                }
            });

            synchronized (cache) {
                cache.clear();
                cache.addAll(items);
            }
            return toJson(items);
        } catch (Throwable t) {
            Log.e(TAG, "scanGenerators 실패", t);
            return "[]";
        }
    }

    private String dumpCache() {
        List<String[]> copy;
        synchronized (cache) {
            copy = new ArrayList<String[]>(cache);
        }
        return toJson(copy);
    }

    private String toJson(List<String[]> items) {
        try {
            JSONArray arr = new JSONArray();
            for (String[] it : items) {
                JSONObject o = new JSONObject();
                o.put("ssid", it[0]);
                o.put("rssi", Integer.parseInt(it[1]));
                arr.put(o);
            }
            return arr.toString();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** 백그라운드 한 번 스캔 트리거. 결과 수신 시 캐시 갱신. */
    @SuppressWarnings("deprecation")
    private void kickScan() {
        try {
            if (scanReceiver != null) return; // 이미 스캔 중
            final Context ctx = activity.getApplicationContext();
            scanReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    try {
                        activity.unregisterReceiver(this);
                    } catch (Throwable ignored) {
                    }
                    scanReceiver = null;
                    String s = scanGenerators(); // 캐시 갱신 목적
                    Log.i(TAG, "백그라운드 스캔 완료 → " + (s == null ? "null" : s.length() + "chars"));
                }
            };
            activity.registerReceiver(scanReceiver,
                    new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION));
            boolean ok = wm().startScan();
            Log.i(TAG, "startScan() 요청: " + ok);
            if (!ok) {
                // 스캔 요청이 거부되면 리시버 정리
                main.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        if (scanReceiver != null) {
                            try {
                                activity.unregisterReceiver(scanReceiver);
                            } catch (Throwable ignored) {
                            }
                            scanReceiver = null;
                        }
                    }
                }, 1500);
            }
        } catch (Throwable t) {
            Log.w(TAG, "kickScan 실패", t);
            scanReceiver = null;
        }
    }

    // ==================================================================
    // 3) connectAndBindWifi(ssid, pin)
    //    - Android 10+ : WifiNetworkSpecifier + requestNetwork 로 접속
    //      (시스템 확인 다이얼로그는 앱이 요청하면 자동 표시됨)
    //    - 접속 완료 콜백에서 bindProcessToNetwork(network) 수행
    //    - LTE(모바일 데이터)는 그대로 유지 → 카톡/인터넷 정상
    // ==================================================================
    @JavascriptInterface
    public void connectAndBindWifi(final String ssid, final String pin) {
        Log.i(TAG, "connectAndBindWifi(ssid=" + ssid + ")");
        if (ssid == null || ssid.length() == 0) return;

        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    unbindWifiInternal();
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        connectSpecifier(ssid, pin);
                    } else {
                        connectLegacy(ssid, pin);
                    }
                } catch (Throwable t) {
                    Log.e(TAG, "connectAndBindWifi 실패", t);
                }
            }
        });
    }

    /** Android 10 (API 29) 이상: WifiNetworkSpecifier */
    private void connectSpecifier(String ssid, String pin) {
        try {
            WifiNetworkSpecifier.Builder sb = new WifiNetworkSpecifier.Builder()
                    .setSsid(ssid);
            if (pin != null && pin.length() > 0) {
                if (pin.length() >= 8) {
                    sb.setWpa2Passphrase(pin);
                } else {
                    // 8자 미만은 WPA-PSK 규격상 불가 → Open(비번없음) 시도
                    Log.w(TAG, "PIN 8자 미만 → open 네트워크로 시도");
                }
            }

            final NetworkRequest req = new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .setNetworkSpecifier(sb.build())
                    .build();

            netCb = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    Log.i(TAG, "onAvailable → bindProcessToNetwork");
                    try {
                        boolean bound = cm().bindProcessToNetwork(network);
                        boundNetwork = network;
                        Log.i(TAG, "bindProcessToNetwork = " + bound);
                    } catch (Throwable t) {
                        Log.e(TAG, "bind 실패", t);
                    }
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            activity.onWifiBridgeConnected(ssid);
                        }
                    });
                }

                @Override
                public void onLost(Network network) {
                    Log.w(TAG, "onLost");
                    if (network != null && network.equals(boundNetwork)) {
                        boundNetwork = null;
                        try {
                            cm().bindProcessToNetwork(null);
                        } catch (Throwable ignored) {
                        }
                        main.post(new Runnable() {
                            @Override
                            public void run() {
                                activity.onWifiBridgeDisconnected(ssid);
                            }
                        });
                    }
                }
            };

            cm().requestNetwork(req, netCb, SCAN_TIMEOUT_MS * 3);
            Log.i(TAG, "requestNetwork 요청됨");
        } catch (Throwable t) {
            Log.e(TAG, "connectSpecifier 실패", t);
        }
    }

    /** Android 9 이하: 레거시 WifiConfiguration */
    @SuppressWarnings({"deprecation", "unchecked"})
    private void connectLegacy(String ssid, String pin) {
        try {
            WifiConfiguration wc = new WifiConfiguration();
            wc.SSID = "\"" + ssid + "\"";
            wc.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK);
            if (pin != null && pin.length() >= 8) {
                wc.preSharedKey = "\"" + pin + "\"";
            } else {
                wc.allowedKeyManagement.clear();
                wc.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
            }
            int netId = wm().addNetwork(wc);
            if (netId < 0) {
                // 이미 저장된 설정이 있으면 재사용
                for (WifiConfiguration ex : wm().getConfiguredNetworks()) {
                    if (ex.SSID != null && ex.SSID.equals("\"" + ssid + "\"")) {
                        netId = ex.networkId;
                        break;
                    }
                }
            }
            wm().disconnect();
            boolean ok = netId >= 0 && wm().enableNetwork(netId, true);
            Log.i(TAG, "legacy enableNetwork = " + ok);
            if (ok) {
                // 레거시는 Network 객체를 못 얻으므로 현재 활성 Wi-Fi 네트워크로 바인딩 시도
                main.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        bindCurrentWifi();
                    }
                }, 2500);
            }
        } catch (Throwable t) {
            Log.e(TAG, "connectLegacy 실패", t);
        }
    }

    @SuppressWarnings("deprecation")
    private void bindCurrentWifi() {
        try {
            NetworkInfo ni = cm().getActiveNetworkInfo();
            if (ni == null || ni.getType() != ConnectivityManager.TYPE_WIFI || !ni.isConnected()) {
                Log.w(TAG, "활성 Wi-Fi 없음 → 바인딩 생략");
                return;
            }
            for (Network n : cm().getAllNetworks()) {
                NetworkCapabilities nc = cm().getNetworkCapabilities(n);
                if (nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    boolean bound = cm().bindProcessToNetwork(n);
                    boundNetwork = n;
                    Log.i(TAG, "legacy bindProcessToNetwork = " + bound);
                    return;
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "bindCurrentWifi 실패", t);
        }
    }

    // ==================================================================
    // 4) unbindWifi
    // ==================================================================
    @JavascriptInterface
    public void unbindWifi() {
        Log.i(TAG, "unbindWifi()");
        main.post(new Runnable() {
            @Override
            public void run() {
                unbindWifiInternal();
            }
        });
    }

    private void unbindWifiInternal() {
        try {
            if (netCb != null) {
                try {
                    cm().unregisterNetworkCallback(netCb);
                } catch (Throwable ignored) {
                }
                netCb = null;
            }
            try {
                cm().bindProcessToNetwork(null);
            } catch (Throwable ignored) {
            }
            boundNetwork = null;
            Log.i(TAG, "바인딩 해제 완료");
        } catch (Throwable t) {
            Log.e(TAG, "unbind 실패", t);
        }
    }

    /** Activity 종료 시 정리 */
    public void destroy() {
        try {
            if (scanReceiver != null) {
                activity.unregisterReceiver(scanReceiver);
                scanReceiver = null;
            }
        } catch (Throwable ignored) {
        }
        unbindWifiInternal();
    }
}
