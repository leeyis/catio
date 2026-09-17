package org.cimbar.camerafilecopy;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.*;
import static org.junit.Assert.*;

@androidx.test.filters.SdkSuppress(minSdkVersion=28)
@RunWith(AndroidJUnit4.class)
public class ReceiverUiTest {
    private static Button button(View view,String label) {
        if(view instanceof Button && ((Button)view).getText().toString().equals(label)) return (Button)view;
        if(view instanceof ViewGroup) for(int i=0;i<((ViewGroup)view).getChildCount();i++) { Button b=button(((ViewGroup)view).getChildAt(i),label); if(b!=null) return b; }
        return null;
    }
    @Test public void offlinePermissionsAndExportCancelKeepTheOriginal() throws Exception {
        Context app=InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(PackageManager.PERMISSION_DENIED,app.checkSelfPermission(Manifest.permission.INTERNET));
        File directory=new File(app.getFilesDir(),"received"); directory.mkdirs();
        File source=new File(directory,"ui-export-cancel.txt");
        try(FileOutputStream out=new FileOutputStream(source)) { out.write("retained original".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity->{
                View root=activity.getWindow().getDecorView();
                View files=activity.findViewById(R.id.tab_files); assertNotNull(files); files.performClick();
                assertTrue(files.isFocusable());
                assertTrue(activity.findViewById(R.id.tab_files).isSelected());
                assertEquals(View.VISIBLE,activity.findViewById(R.id.received_files).getVisibility());
                Button save=button(root,activity.getString(R.string.save)); assertNotNull(save);
                // Deliver the actual Activity result path without relying on a specific device file picker.
                activity.onActivityResult(11,Activity.RESULT_CANCELED,null);
                assertTrue(source.isFile()); assertEquals(17,source.length());
                activity.getOnBackPressedDispatcher().onBackPressed();
                assertEquals(View.GONE,activity.findViewById(R.id.received_files).getVisibility());
            });
        } finally { assertTrue(source.delete()); }
    }
    @Test public void pauseHasVisibleFeedbackAndSurvivesRecreation() throws Exception {
        Context app=InstrumentationRegistry.getInstrumentation().getTargetContext();
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(app.getPackageName(),Manifest.permission.CAMERA);
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity->{ Button pause=activity.findViewById(R.id.pause_receive); assertTrue(pause.isEnabled()); pause.performClick(); });
            SystemClock.sleep(600);
            scenario.onActivity(activity->{TextView status=activity.findViewById(R.id.scan_status); assertEquals(activity.getString(R.string.status_paused),status.getText().toString());});
            scenario.recreate();
            scenario.onActivity(activity->{Button pause=activity.findViewById(R.id.pause_receive); assertEquals(activity.getString(R.string.resume),pause.getText().toString());});
        }
    }
}
