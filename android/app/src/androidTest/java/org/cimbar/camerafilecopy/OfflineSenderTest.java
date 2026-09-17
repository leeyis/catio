package org.cimbar.camerafilecopy;

import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class OfflineSenderTest {
    private String evaluate(ActivityScenario<WebViewActivity> scenario,String script) throws Exception {
        CountDownLatch latch=new CountDownLatch(1); AtomicReference<String> value=new AtomicReference<>();
        scenario.onActivity(activity->{WebView view=activity.findViewById(R.id.sender_webview); view.evaluateJavascript(script,result->{value.set(result); latch.countDown();});});
        assertTrue("WebView must respond",latch.await(10,TimeUnit.SECONDS)); return value.get();
    }
    @Test public void bundledOfflineSenderEncodesAndTreatsFilenamesAsText() throws Exception {
        try(ActivityScenario<WebViewActivity> scenario=ActivityScenario.launch(WebViewActivity.class)) {
            long deadline=SystemClock.elapsedRealtime()+45000;
            while(!"true".equals(evaluate(scenario,"typeof Wormhole !== 'undefined' && Wormhole.ready()"))) {
                assertTrue("Offline WASM and host skin must initialize",SystemClock.elapsedRealtime()<deadline); SystemClock.sleep(300);
            }
            assertEquals("true",evaluate(scenario,"!document.querySelector('#nav-container') && document.querySelectorAll('button').length===1"));
            scenario.onActivity(activity->activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            deadline=SystemClock.elapsedRealtime()+45000;
            while(!"true".equals(evaluate(scenario,"innerWidth>innerHeight && typeof Wormhole !== 'undefined' && Wormhole.ready()"))) {
                assertTrue("Landscape sender must reload",SystemClock.elapsedRealtime()<deadline); SystemClock.sleep(300);
            }
            assertEquals("true",evaluate(scenario,"(()=>{Wormhole.importFile(new File([new Uint8Array(4096)], '<img src=x onerror=window.filenameExecuted=true>.bin'));return true})()"));
            deadline=SystemClock.elapsedRealtime()+15000;
            while(!"true".equals(evaluate(scenario,"document.body.classList.contains('playing')"))) {
                assertTrue("Chosen file must start encoding",SystemClock.elapsedRealtime()<deadline); SystemClock.sleep(100);
            }
            assertEquals("true",evaluate(scenario,"document.getElementById('filename').textContent.startsWith('<img') && !document.getElementById('filename').querySelector('img') && !window.filenameExecuted"));
            assertEquals("All four code corners must remain visible in landscape", "true", evaluate(scenario,
                "(()=>{const r=document.getElementById('canvas').getBoundingClientRect();return r.width>0 && r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1})()"));
            scenario.onActivity(activity->assertTrue(activity.findViewById(R.id.tab_send).isSelected()));
        }
    }
}
