package org.cimbar.camerafilecopy;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.TextView;
import android.widget.ProgressBar;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.opencv.android.Utils;
import org.opencv.core.Mat;
import java.io.*;
import java.util.ArrayList;
import java.util.List;
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
    private static byte[] read(InputStream source) throws IOException {
        try(InputStream in=source; ByteArrayOutputStream out=new ByteArrayOutputStream()) {
            byte[] buffer=new byte[8192]; int n; while((n=in.read(buffer))!=-1) out.write(buffer,0,n);
            return out.toByteArray();
        }
    }
    private static File nextFixtureFile(File directory) {
        String stem="Catio-互通验证-🐈";
        for(int n=0;;n++) {
            File file=new File(directory,stem+(n==0?"":" ("+n+")")+".bin");
            if(!file.exists()) return file;
        }
    }
    @Test public void resetButtonResumesAndReceivesTheSameFileThreeTimes() throws Exception {
        Context app=InstrumentationRegistry.getInstrumentation().getTargetContext();
        Context fixtures=InstrumentationRegistry.getInstrumentation().getContext();
        InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(app.getPackageName(),Manifest.permission.CAMERA);
        byte[] original=read(fixtures.getAssets().open("interop/expected.bin"));
        File directory=new File(app.getFilesDir(),"received");
        Mat[] frames=new Mat[12]; List<File> created=new ArrayList<>();
        try {
            assertTrue(NativeReceiver.initialize());
            for(int i=0;i<frames.length;i++) {
                try(InputStream in=fixtures.getAssets().open(String.format(java.util.Locale.ROOT,"interop/frame-%02d.png",i))) {
                    Bitmap bitmap=BitmapFactory.decodeStream(in); frames[i]=new Mat(); Utils.bitmapToMat(bitmap,frames[i]); bitmap.recycle();
                }
            }
            try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
                for(int round=0;round<3;round++) {
                    // Use the real on-screen action, including resetting from paused state.
                    scenario.onActivity(activity->{
                        Button reset=activity.findViewById(R.id.reset_receive); assertTrue(reset.isShown()); assertTrue(reset.isEnabled()); reset.performClick();
                        Button pause=activity.findViewById(R.id.pause_receive); assertEquals(activity.getString(R.string.pause),pause.getText().toString());
                        assertEquals(activity.getString(R.string.status_search),((TextView)activity.findViewById(R.id.scan_status)).getText().toString());
                        assertEquals(0,((ProgressBar)activity.findViewById(R.id.receive_progress)).getProgress());
                        TextView latest=activity.findViewById(R.id.latest_received); assertEquals(View.GONE,latest.getVisibility()); assertEquals("",latest.getText().toString());
                        ScanSnapshot cleared=new ScanSnapshot(NativeReceiver.snapshot());
                        assertEquals(0,cleared.completed); assertEquals(0,cleared.uniqueBytes); assertEquals(0,cleared.streams);
                        // Feed real encoded frames deterministically instead of the emulator camera.
                        pause.performClick();
                    });
                    File expected=nextFixtureFile(directory); created.add(expected);
                    long deadline=SystemClock.elapsedRealtime()+20000; int frame=0;
                    while(new ScanSnapshot(NativeReceiver.snapshot()).completed==0 && SystemClock.elapsedRealtime()<deadline) {
                        NativeReceiver.submit(frames[frame++%12].getNativeObjAddr(),directory.getAbsolutePath(),68); SystemClock.sleep(40);
                    }
                    assertTrue("File must complete after the visible reset action",expected.isFile());
                    assertEquals(1,new ScanSnapshot(NativeReceiver.snapshot()).completed);
                    for(File saved:created) assertArrayEquals("Previous copies must remain intact",original,read(new FileInputStream(saved)));
                    SystemClock.sleep(600);
                    scenario.onActivity(activity->{
                        TextView latest=activity.findViewById(R.id.latest_received); assertEquals(View.VISIBLE,latest.getVisibility());
                        assertTrue(latest.getText().toString().contains(expected.getName()));
                    });
                    // A looping sender must not create another copy until the user resets.
                    for(Mat mat:frames) { NativeReceiver.submit(mat.getNativeObjAddr(),directory.getAbsolutePath(),68); SystemClock.sleep(40); }
                    SystemClock.sleep(600);
                    assertEquals(1,new ScanSnapshot(NativeReceiver.snapshot()).completed);
                }
            }
        } finally {
            NativeReceiver.reset();
            for(Mat frame:frames) if(frame!=null) frame.release();
            for(File file:created) if(file.exists()) assertTrue(file.delete());
        }
    }
}
