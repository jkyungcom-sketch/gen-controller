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
import android.net.LinkProperties;
import android.net.RouteInfo;
import android.net.wifi.WifiInfo;
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
import java.util.Locale;

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
    // ★ 추가: 대소문자 무시 "korea" 로 시작하는 SSID 도 발전기로 인식 (예: korea1112)
    private static final String SSID_PREFIX_2 = "korea";
    private static final long SCAN_TIMEOUT_MS = 6000L;

    /** 최근 스캔 캐시. 연결 성공 시에도 갱신. */
    private final List<String[]> cache = Collections.synchronizedList(new ArrayList<String[]>());

    // ==================================================================
    // ★ SSID 정규화 (단일 진실 소스)
    //   Android 는 WifiManager.getScanResults()[].SSID 를 "\"korea1112\"" 처럼
    //   큰따옴표로 감싸 반환하는 경우가 있다. 그대로 WebView 로 넘기면
    //   JS 의 extractPinFromName() 정규식 /(\d{4})$/ 가 끝의 따옴표 때문에
    //   실패하여 기본값 "0000" 과 비교하는 버그가 발생한다.
    //   → 브릿지 경계에서 무조건 앞뒤 따옴표/공백을 제거한다.
    // ==================================================================
    static String cleanSsid(String raw) {
        if (raw == null) return "";
        String s = raw.replace("\"", "").trim();
        return s;
    }

    private final MainActivity activity;
    private final Handler main = new Handler(Looper.getMainLooper());

    private ConnectivityManager connMgr;
    private WifiManager wifiMgr;

    /** 현재 바인딩된 발전기 네트워크 */
    private Network boundNetwork = null;
    private ConnectivityManager.NetworkCallback netCb = null;

    /** ★ 직전 unbind 시각 — onAvailable 이 늦게 와도 끊긴 네트워크를 바인딩하는 사고 방지 */
    private long unboundAt = 0L;
    /** ★ 재시도 1회만 허용 (무한 루프 금지) */
    private static final long RETRY_DELAY_MS = 1500L;

    /** ★ 연결 실패 보고를 아직 안 보냈는지 (중복 방지) */
    private boolean failureReported = false;

    private BroadcastReceiver scanReceiver = null;
    private int cachedRssi = -127;
    /** 레거시 경로에서 bind 검증 시 사용할 SSID */
    private String cachedLegacySsid = "";
    /** ESP32 대역(192.168.4.x) 으로 판명된 네트워크 캐시 */
    private Network cachedEspNetwork = null;
    private String cachedEspGateway = "";

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
                String ssid = cleanSsid(r.SSID);   // ★ 따옴표/공백 제거 후 판별·반환
                if (ssid.isEmpty()) continue;
                if (!isGeneratorSsid(ssid)) continue;
                items.add(new String[]{ssid, String.valueOf(r.level)});
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

    /**
     * 발전기 SSID 판별
     *   - "JKYUNG_" 로 시작 (대소문자 구분 없음)
     *   - 또는 "korea" 로 시작 (대소문자 구분 없음, 예: korea1112 / Korea1112 / KOREA-1)
     * Android 의 SSID 는 보통 대문자로 정규화되지만 기기/AP 설정에 따라
     * 소문자·혼합이 올 수 있으므로 대소문자를 무시하고 비교한다.
     */
    private static boolean isGeneratorSsid(String ssid) {
        ssid = cleanSsid(ssid);
        if (ssid.isEmpty()) return false;
        String u = ssid.toUpperCase(Locale.US);
        return u.startsWith(SSID_PREFIX) || u.startsWith(SSID_PREFIX_2.toUpperCase(Locale.US));
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
            IntentFilter scanFilter = new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
            if (Build.VERSION.SDK_INT >= 33) {
                // Android 13+ : 시스템 브로드캐스트는 RECEIVER_NOT_EXPORTED 필수
                activity.registerReceiver(scanReceiver, scanFilter,
                        Context.RECEIVER_NOT_EXPORTED);
            } else {
                activity.registerReceiver(scanReceiver, scanFilter);
            }
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
    public void connectAndBindWifi(final String rawSsid, final String rawPin) {
        // ★ WebView 에서 넘어온 값도 정규화 (JS 쪽 구버전 호출 대비 이중 방어)
        final String ssid = cleanSsid(rawSsid);
        final String pin  = (rawPin == null) ? "" : rawPin.replace("\"", "").trim();
        Log.i(TAG, "connectAndBindWifi(ssid=" + ssid + ", pinLen=" + pin.length() + ")");
        if (ssid.length() == 0) return;

        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    unboundAt = System.currentTimeMillis();
                    failureReported = false;
                    unbindWifiInternal();
                    // ★★ 최우선: 사용자가 폰 기본 설정에서 이미 "korea1112" Wi-Fi 에
                    //     연결해 둔 상태라면 requestNetwork 스펙을 기다리지 말고
                    //     현재 활성 Wi-Fi Network 를 즉시 bindProcessToNetwork 한다.
                    //     (LTE 가 켜져 있어도 192.168.4.1 트래픽이 바로 나가게 됨)
                    // ③ 지시: 이미 korea1112(또는 192.168.4.x)에 연결돼 있으면 즉시 bind 후 리턴.
                    //    연결돼 있지 않으면 bindExisting 은 false 를 돌려주고,
                    //    지체 없이 아래 WifiNetworkSpecifier 시스템 팝업 경로로 넘어간다.
                    boolean already = bindExistingWifiIfMatches(ssid);
                    if (already) {
                        Log.i(TAG, "이미 연결된 Wi-Fi 발견 → 즉시 바인딩 완료: " + ssid);
                        return;
                    }
                    // 연결 안 됨 → 즉시 시스템 연결 팝업 (LTE/카톡 유지형)
                    Log.i(TAG, "기존 연결 없음 → WifiNetworkSpecifier 시스템 팝업 요청");
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        connectSpecifier(ssid, pin, 0);
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
    private void connectSpecifier(String ssid, String pin, final int attempt) {
        try {
            // ★ 중복 requestNetwork 는 안드로이드가 팝업을 무시하는 버그를 만든다.
            //   진입 즉시 이전 콜백을 깨끗이 해제한다.
            if (netCb != null) {
                try {
                    cm().unregisterNetworkCallback(netCb);
                    Log.i(TAG, "이전 NetworkCallback 해제 완료");
                } catch (Throwable ignored) {
                }
                netCb = null;
            }

            WifiNetworkSpecifier.Builder sb = new WifiNetworkSpecifier.Builder()
                    .setSsid(ssid);
            // ★ 오픈 네트워크(ESP32 AP) 는 pin 이 빈 문자열이므로 아무 키도 지정하지 않는다.
            //   - pin 8자 이상 : WPA2 PSK
            //   - pin 1~7자    : WPA 규격상 불가능 → Open 으로 폴백 (로그만)
            //   - pin 빈 문자열: Open (ESP32 AP 기본값) ← 셜대 로그 경고 없이 정상 경로
            if (pin != null && pin.length() >= 8) {
                sb.setWpa2Passphrase(pin);
            } else if (pin != null && pin.length() > 0) {
                Log.w(TAG, "PIN 8자 미만 → open 네트워크로 시도 (len=" + pin.length() + ")");
            } else {
                Log.i(TAG, "PIN 미지정 → Open(개방) 네트워크로 접속 시도");
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
                    // ★ bind 직후 실제 트래픽 경로를 확인하고 결과를 JS 로 전딜
                    main.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            verifyAndReport(network, ssid);
                        }
                    }, 600);
                }

                @Override
                public void onUnavailable() {
                    // ★ 접속 실패 (AP 미기동 / 비번 불일치 / 타임아웃)
                    Log.w(TAG, "onUnavailable (attempt=" + attempt + ") ssid=" + ssid);
                    if (attempt < 1) {
                        retryLater("unavailable", ssid);
                    } else {
                        reportFailure(ssid, "unavailable");
                    }
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

            // ★ 시스템 연결 팝업은 UI 스레드(Handler)에서 요청해야 확실히 뜬다.
            //   + 15초 타임아웃을 걸어 콜백이 영영 안 와도 앱이 먹통되지 않게 한다.
            //   requestNetwork(NetworkRequest, NetworkCallback, Handler, timeoutMs) 는 API 26+
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                cm().requestNetwork(req, netCb, new Handler(Looper.getMainLooper()), 15000);
                Log.i(TAG, "requestNetwork 요청됨 (main handler, timeout=15s)");
            } else {
                cm().requestNetwork(req, netCb);
                Log.i(TAG, "requestNetwork 요청됨 (legacy)");
                // 구버전은 타임아웃 인자가 없으므로 직접 15초 워치독
                main.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        if (boundNetwork == null) {
                            Log.w(TAG, "15초 워치독 → 연결 실패 처리");
                            reportFailure(ssid, "timeout");
                        }
                    }
                }, 15000);
            }
        } catch (Throwable t) {
            Log.e(TAG, "connectSpecifier 실패", t);
        }
    }

    /** Android 9 이하: 레거시 WifiConfiguration */
    @SuppressWarnings({"deprecation", "unchecked"})
    private void connectLegacy(String ssid, String pin) {
        try {
            cachedLegacySsid = ssid;
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
                    verifyAndReport(n, cachedLegacySsid);
                    return;
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "bindCurrentWifi 실패", t);
        }
    }

    // ==================================================================
    // ★ bind 후 실제 트래픽 경로 검증 + 결과 JS 보고
    //   bindProcessToNetwork 가 true 를 돌려줘도 실제 소켓이 AP 로 가는지는
    //   별개다. 활성 네트워크가 진짜 Wi-Fi 인지 확인하고 JS 에 알린다.
    // ==================================================================
    @SuppressWarnings("deprecation")
    private void verifyAndReport(Network network, final String ssid) {
        try {
            Network active = cm().getActiveNetwork();
            boolean activeIsWifi = false;
            boolean sameNetwork = false;
            if (active != null) {
                NetworkCapabilities nc = cm().getNetworkCapabilities(active);
                activeIsWifi = (nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
                sameNetwork = active.equals(network);
            }
            // getBoundNetworkForProcess() 는 API 23+
            Network boundForProc = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                boundForProc = cm().getBoundNetworkForProcess();
            }
            boolean procBound = boundForProc != null;

            Log.i(TAG, String.format(
                    "[verify] activeIsWifi=%s sameNetwork=%s procBound=%s",
                    activeIsWifi, sameNetwork, procBound));

            if (!procBound) {
                reportFailure(ssid, "bind_failed");
                return;
            }
            activity.onWifiBridgeConnected(ssid);
        } catch (Throwable t) {
            Log.e(TAG, "verifyAndReport 실패", t);
            activity.onWifiBridgeConnected(ssid); // 검증 실패해도 연결 자체는 알린다
        }
    }

    /**
     * ⚠️ Android 12+ 에서 WifiInfo SSID 는 위치 권한 없으면 "<unknown ssid>" 로 온다.
     *     (Android 12+ 에서 WifiInfo SSID 는 위치 권한 없으면 "<unknown ssid>")
     */
    @SuppressWarnings("deprecation")
    private String currentSsidSafe() {
        try {
            WifiInfo info = wm().getConnectionInfo();
            if (info == null) return "";
            String s = cleanSsid(info.getSSID());
            if (s.startsWith("<")) return "";   // <unknown ssid> 방어
            return s;
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 현재 Wi-Fi 의 IPv4 게이트웨이가 ESP32 대역(192.168.4.x) 인지 확인.
     * SSID 를 못 읽는 경우(<unknown ssid>) 의 최후 수단.
     */
    private boolean isEspSubnetActive() {
        try {
            for (Network n : cm().getAllNetworks()) {
                NetworkCapabilities nc = cm().getNetworkCapabilities(n);
                if (nc == null || !nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;

                LinkProperties lp = cm().getLinkProperties(n);
                if (lp == null) continue;

                String gw = null;
                if (lp.getRoutes() != null) {
                    for (RouteInfo r : lp.getRoutes()) {
                        if (r.isDefaultRoute() && r.getGateway() != null) {
                            gw = r.getGateway().getHostAddress();
                            break;
                        }
                    }
                }
                if (gw == null) continue;

                Log.i(TAG, "Wi-Fi 게이트웨이 = " + gw);
                if (gw.startsWith("192.168.4.")) {
                    cachedEspNetwork = n;
                    cachedEspGateway = gw;
                    return true;
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "isEspSubnetActive 실패", t);
        }
        return false;
    }

    // ==================================================================
    // ★★ 이미 연결된 Wi-Fi 를 즉시 바인딩 (가장 흔한 실패 경로 해결)
    //   Android 10+ 에서는 앱이 requestNetwork 로 만든 네트워크만 bind 되기
    //   쉽고, 사용자가 설정 앱에서 직접 연결한 AP 는 앱 프로세스에 묶이지 않아
    //   fetch("http://192.168.4.1/status") 가 LTE 로 새거나 실패한다.
    //   → getAllNetworks() 에서 TRANSPORT_WIFI 를 찾아 SSID 까지 대조하고 bind.
    // ==================================================================
    @SuppressWarnings("deprecation")
    private boolean bindExistingWifiIfMatches(String wantSsid) {
        try {
            String curSsid = currentSsidSafe();
            Log.i(TAG, "현재 연결된 Wi-Fi SSID = '" + curSsid + "' (요청 '" + wantSsid + "')");

            // ① SSID 가 같으면 바로 바인딩
            // ② SSID 를 못 읽거나(<unknown ssid>) 달라도 게이트웨이가 192.168.4.x 이면
            //    ESP32 AP 가 확실하므로 강제 바인딩한다. (소비자는 설정을 안 건드린다)
            boolean ssidMatch = curSsid.length() > 0 && curSsid.equalsIgnoreCase(wantSsid);
            if (!ssidMatch) {
                if (!isEspSubnetActive()) {
                    Log.i(TAG, "SSID 불일치 + ESP 대역 아님 → 기존 네트워크 바인딩 생략");
                    return false;
                }
                Log.i(TAG, "SSID 불일치지만 게이트웨이 " + cachedEspGateway
                        + " (ESP32 대역) → 강제 바인딩 진행");
                Network esp = cachedEspNetwork;
                if (esp == null) return false;

                boolean forced = cm().bindProcessToNetwork(esp);
                Log.i(TAG, "ESP 대역 강제 bindProcessToNetwork = " + forced);
                if (!forced) return false;

                boundNetwork = esp;
                main.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        verifyAndReport(esp, wantSsid);
                    }
                }, 600);
                return true;
            }

            for (Network n : cm().getAllNetworks()) {
                NetworkCapabilities nc = cm().getNetworkCapabilities(n);
                if (nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    boolean bound = cm().bindProcessToNetwork(n);
                    Log.i(TAG, "기존 Wi-Fi bindProcessToNetwork = " + bound);
                    if (bound) {
                        final Network bn = n;
                        boundNetwork = n;
                        // 600ms 뒤 실제 트래픽 경로 검증 후 JS 보고
                        main.postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                verifyAndReport(bn, wantSsid);
                            }
                        }, 600);
                        return true;
                    }
                }
            }
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "bindExistingWifiIfMatches 실패", t);
            return false;
        }
    }

    /** 연결 실패를 JS 로 알린다 (UI 가 '목록 없음' 으로만 보이지 않게) */
    private void reportFailure(final String ssid, final String reason) {
        if (failureReported) {   // 중복 보고 방지
            Log.w(TAG, "연결 실패 중복 보고 무시: " + reason);
            return;
        }
        failureReported = true;
        Log.w(TAG, "연결 실패 보고: " + reason + " / " + ssid);
        try {
            activity.onWifiBridgeFailed(ssid, reason);
        } catch (Throwable t) {
            Log.e(TAG, "onWifiBridgeFailed 호출 실패", t);
        }
    }

    /** 1회 재시도 (unbind 직후 늦게 도착한 onAvailable 로 인한 실패 대응) */
    private void retryLater(final String reason, final String ssid) {
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                long since = System.currentTimeMillis() - unboundAt;
                Log.i(TAG, "재시도(" + reason + ") since unbind=" + since + "ms");
                connectSpecifier(ssid, "", 1);
            }
        }, RETRY_DELAY_MS);
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
