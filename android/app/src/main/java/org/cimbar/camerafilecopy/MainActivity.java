package org.cimbar.camerafilecopy;

import android.Manifest;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.view.GestureDetector;
import android.view.ScaleGestureDetector;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.widget.*;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import org.opencv.android.CameraBridgeViewBase;
import org.opencv.core.Mat;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import static org.cimbar.camerafilecopy.ReceiverUi.*;

public class MainActivity extends ComponentActivity implements CameraBridgeViewBase.CvCameraViewListener2 {
    private static final int CAMERA_REQUEST=10, CREATE_FILE=11;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private final TransferStats stats=new TransferStats();
    private OpencvCameraView camera;
    private ScanOverlay overlay;
    private LinearLayout root, center, dashboard, library, permissionCard;
    private FrameLayout preview;
    private TextView statusText, hintText, speedText, qualityText, progressText, etaText, latestText;
    private ProgressBar progress;
    private Button pauseButton, resetButton, permissionButton;
    private LinearLayout navigation;
    private SeekBar zoomControl;
    private TextView zoomLabel;
    private boolean initialized, resumed, filesVisible, askedPermission, exporting;
    private volatile boolean paused, cameraReady;
    private int permissionUiState=-1;
    private volatile int mode;
    private File receivedDirectory;
    private String pendingSave, latestName;
    private long lastErrorCount, cameraStartedAt;
    private ScanSnapshot snapshot=new ScanSnapshot(null);
    private ScanGuidance.Hint shownHint=ScanGuidance.Hint.SEARCH, pendingHint=shownHint;
    private long hintSince;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WindowCompat.setDecorFitsSystemWindows(getWindow(),false);
        receivedDirectory=new File(getFilesDir(),"received");
        boolean storageReady=receivedDirectory.isDirectory() || receivedDirectory.mkdirs();
        initialized=NativeReceiver.initialize() && storageReady;
        mode=getPreferences(MODE_PRIVATE).getInt("mode",0);
        filesVisible=getIntent().getIntExtra("tab",0)==2;
        if(state!=null) { pendingSave=state.getString("pendingSave"); filesVisible=state.getBoolean("filesVisible"); paused=state.getBoolean("paused"); }
        getOnBackPressedDispatcher().addCallback(this,new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { if(filesVisible) showFiles(false); else finish(); }
        });
        buildUi();
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("pendingSave",pendingSave); state.putBoolean("filesVisible",filesVisible); state.putBoolean("paused",paused);
        super.onSaveInstanceState(state);
    }
    private void buildUi() {
        permissionUiState=-1;
        root=column(this); root.setBackgroundColor(color(this,R.color.canvas));
        ViewCompat.setOnApplyWindowInsetsListener(root,(v,insets)->{
            Insets bars=insets.getInsets(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left,bars.top,bars.right,bars.bottom); return insets;
        });
        LinearLayout header=row(this); header.setPadding(dp(this,20),dp(this,12),dp(this,16),dp(this,12));
        ImageView logo=new ImageView(this); logo.setImageResource(R.drawable.ic_catio); logo.setContentDescription(getString(R.string.app_name));
        header.addView(logo,new LinearLayout.LayoutParams(dp(this,40),dp(this,40)));
        LinearLayout title=column(this); title.setPadding(dp(this,12),0,0,0);
        title.addView(text(this,"Catio",21,R.color.text_primary,true)); title.addView(text(this,getString(R.string.tagline),11,R.color.text_secondary,false));
        header.addView(title,weight());
        TextView offline=text(this,getString(R.string.offline),11,R.color.success,true); offline.setPadding(dp(this,10),dp(this,6),dp(this,10),dp(this,6));
        offline.setBackground(surface(this,R.color.surface,20)); header.addView(offline);
        Button options=button(this,getString(R.string.options),false); options.setId(R.id.receiver_options); options.setOnClickListener(v->showOptions());
        LinearLayout.LayoutParams optionParams=new LinearLayout.LayoutParams(-2,dp(this,48)); optionParams.leftMargin=dp(this,8); header.addView(options,optionParams);
        root.addView(header);
        center=new LinearLayout(this);
        boolean landscape=getResources().getConfiguration().orientation==Configuration.ORIENTATION_LANDSCAPE;
        center.setOrientation(landscape?LinearLayout.HORIZONTAL:LinearLayout.VERTICAL); center.setPadding(dp(this,16),0,dp(this,16),0);
        root.addView(center,new LinearLayout.LayoutParams(-1,0,1));
        preview=new FrameLayout(this); preview.setBackground(surface(this,R.color.camera,24)); preview.setClipToOutline(true);
        center.addView(preview,landscape?new LinearLayout.LayoutParams(0,-1,1):new LinearLayout.LayoutParams(-1,0,1));
        camera=new OpencvCameraView(this,CameraBridgeViewBase.CAMERA_ID_BACK); camera.setId(R.id.receiver_camera);
        camera.setContentDescription(getString(R.string.touch_focus));
        camera.setVisibility(SurfaceView.VISIBLE); camera.setMaxFrameSize(1920,1920); camera.setCvCameraViewListener(this);
        preview.addView(camera,new FrameLayout.LayoutParams(-1,-1));
        overlay=new ScanOverlay(this); preview.addView(overlay,new FrameLayout.LayoutParams(-1,-1));
        GestureDetector taps=new GestureDetector(this,new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(android.view.MotionEvent e) { return true; }
            @Override public boolean onSingleTapUp(android.view.MotionEvent e) { if(cameraReady) camera.focusAt(e.getX(),e.getY()); camera.performClick(); return true; }
        });
        ScaleGestureDetector pinch=new ScaleGestureDetector(this,new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override public boolean onScale(ScaleGestureDetector detector) { camera.setZoomRatio(camera.getZoomRatio()*detector.getScaleFactor()); syncZoom(); return true; }
        });
        final boolean[] pinched={false};
        camera.setOnClickListener(v->{if(cameraReady)camera.refocus();});
        camera.setOnTouchListener((v,e)->{
            if(e.getActionMasked()==android.view.MotionEvent.ACTION_DOWN) pinched[0]=false;
            if(e.getPointerCount()>1) pinched[0]=true;
            pinch.onTouchEvent(e); if(!pinched[0]) taps.onTouchEvent(e); return true;
        });
        TextView focus=text(this,getString(R.string.touch_focus),12,R.color.text_primary,false); focus.setTextColor(Color.WHITE); focus.setBackgroundColor(0x990B1020); focus.setGravity(Gravity.CENTER);
        LinearLayout zoomRow=row(this); zoomRow.setPadding(dp(this,12),dp(this,3),dp(this,12),dp(this,3)); zoomRow.setBackgroundColor(0xB30B1020);
        zoomLabel=text(this,"1.0×",12,R.color.text_primary,true); zoomLabel.setTextColor(Color.WHITE); zoomRow.addView(zoomLabel,new LinearLayout.LayoutParams(dp(this,44),-2));
        zoomControl=new SeekBar(this); zoomControl.setId(R.id.zoom_control); zoomControl.setMax(300); zoomControl.setContentDescription(getString(R.string.zoom));
        zoomControl.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.WHITE)); zoomControl.setThumbTintList(android.content.res.ColorStateList.valueOf(Color.WHITE));
        zoomControl.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar bar,int value,boolean user) { if(user) { camera.setZoomRatio(1+value/100f); syncZoom(); } }
            @Override public void onStartTrackingTouch(SeekBar bar) { }
            @Override public void onStopTrackingTouch(SeekBar bar) { }
        });
        zoomRow.addView(zoomControl,new LinearLayout.LayoutParams(0,dp(this,36),1));
        LinearLayout cameraTools=column(this); focus.setTextSize(11); cameraTools.addView(focus,new LinearLayout.LayoutParams(-1,dp(this,26))); cameraTools.addView(zoomRow);
        FrameLayout.LayoutParams focusParams=new FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM); preview.addView(cameraTools,focusParams);
        permissionCard=column(this); permissionCard.setGravity(Gravity.CENTER); permissionCard.setPadding(dp(this,28),dp(this,20),dp(this,28),dp(this,20));
        permissionCard.setBackgroundColor(color(this,R.color.camera)); preview.addView(permissionCard,new FrameLayout.LayoutParams(-1,-1));
        dashboard=column(this); dashboard.setPadding(dp(this,18),dp(this,16),dp(this,18),dp(this,14)); dashboard.setBackground(surface(this,R.color.surface,20));
        ScrollView dashboardScroll=new ScrollView(this); dashboardScroll.setFillViewport(true); dashboardScroll.addView(dashboard);
        LinearLayout.LayoutParams dashParams=landscape?new LinearLayout.LayoutParams(dp(this,310),-1):new LinearLayout.LayoutParams(-1,-2);
        if(landscape) dashParams.leftMargin=dp(this,12); else dashParams.topMargin=dp(this,12); center.addView(dashboardScroll,dashParams);
        statusText=text(this,getString(R.string.status_search),16,R.color.text_primary,true); statusText.setId(R.id.scan_status);
        ViewCompat.setAccessibilityLiveRegion(statusText,ViewCompat.ACCESSIBILITY_LIVE_REGION_POLITE); dashboard.addView(statusText);
        hintText=text(this,getString(R.string.guide_search),13,R.color.text_secondary,false); hintText.setId(R.id.scan_hint); hintText.setMinLines(landscape?1:2); hintText.setPadding(0,dp(this,6),0,dp(this,12)); dashboard.addView(hintText);
        LinearLayout metrics=row(this);
        LinearLayout speed=column(this); speedText=text(this,"—",25,R.color.text_primary,true); speedText.setId(R.id.receive_speed); speed.addView(speedText); speed.addView(text(this,getString(R.string.speed_label),11,R.color.text_secondary,false)); metrics.addView(speed,weight());
        LinearLayout quality=column(this); qualityText=text(this,"—",25,R.color.text_primary,true); qualityText.setId(R.id.recognition_quality); quality.addView(qualityText); quality.addView(text(this,getString(R.string.quality_label),11,R.color.text_secondary,false)); metrics.addView(quality,weight());
        metrics.setOnClickListener(v->new AlertDialog.Builder(this).setMessage(R.string.stats_note).setPositiveButton(R.string.done,null).show());
        metrics.setContentDescription(getString(R.string.stats_note)); dashboard.addView(metrics);
        progressText=text(this,getString(R.string.waiting_data),12,R.color.text_secondary,false); progressText.setPadding(0,dp(this,12),0,dp(this,6)); dashboard.addView(progressText);
        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal); progress.setId(R.id.receive_progress); progress.setMax(1000);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(color(this,R.color.accent))); dashboard.addView(progress,new LinearLayout.LayoutParams(-1,dp(this,5)));
        etaText=text(this,getString(R.string.estimate_wait),11,R.color.text_secondary,false); etaText.setPadding(0,dp(this,5),0,dp(this,10)); dashboard.addView(etaText);
        LinearLayout controls=row(this); pauseButton=button(this,getString(paused?R.string.resume:R.string.pause),true); pauseButton.setId(R.id.pause_receive);
        pauseButton.setOnClickListener(v->{ paused=!paused; stats.clear(); pauseButton.setText(paused?R.string.resume:R.string.pause); }); controls.addView(pauseButton,weight());
        resetButton=button(this,getString(R.string.reset),false); resetButton.setId(R.id.reset_receive);
        resetButton.setContentDescription(getString(R.string.reset)+"。"+getString(R.string.reset_body));
        resetButton.setOnClickListener(v->resetReception());
        LinearLayout.LayoutParams resetParams=weight(); resetParams.leftMargin=dp(this,10); controls.addView(resetButton,resetParams);
        dashboard.addView(controls);
        latestText=text(this,"",12,R.color.success,true); latestText.setId(R.id.latest_received); latestText.setPadding(0,dp(this,10),0,0); latestText.setVisibility(View.GONE); latestText.setMaxLines(2); latestText.setOnClickListener(v->showFiles(true)); dashboard.addView(latestText);
        library=column(this); library.setId(R.id.received_files); library.setPadding(dp(this,20),0,dp(this,20),0); root.addView(library,new LinearLayout.LayoutParams(-1,0,1));
        navigation=navigation(this,filesVisible?2:0,this::selectTab); root.addView(navigation);
        setContentView(root); applySystemBars(this,root); ViewCompat.requestApplyInsets(root);
        updatePermissionUi(); showFiles(filesVisible);
    }
    private boolean hasCameraPermission() { return ContextCompat.checkSelfPermission(this,Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED; }
    private void updatePermissionUi() {
        boolean allowed=hasCameraPermission();
        pauseButton.setEnabled(initialized && allowed);
        resetButton.setEnabled(initialized);
        if(initialized && allowed && cameraReady) { permissionCard.setVisibility(View.GONE); permissionUiState=-1; return; }
        permissionCard.setVisibility(View.VISIBLE);
        int title=!initialized?R.string.camera_error:!allowed?R.string.permission_title:cameraStartedAt>0&&SystemClock.elapsedRealtime()-cameraStartedAt>5000?R.string.camera_error:R.string.camera_starting;
        if(permissionUiState==title) return;
        permissionUiState=title; permissionCard.removeAllViews();
        TextView h=text(this,getString(title),20,R.color.text_primary,true); h.setTextColor(Color.WHITE); h.setGravity(Gravity.CENTER); permissionCard.addView(h);
        TextView body=text(this,getString(!initialized?R.string.init_error:!allowed?R.string.permission_body:R.string.camera_error_body),13,R.color.text_secondary,false);
        body.setTextColor(0xFFBAC6D9); body.setGravity(Gravity.CENTER); body.setPadding(0,dp(this,14),0,dp(this,20)); permissionCard.addView(body);
        permissionButton=button(this,getString(!allowed?R.string.permission_action:R.string.retry),true); permissionButton.setId(R.id.camera_permission);
        permissionButton.setOnClickListener(v->{
            if(!hasCameraPermission()) {
                if(askedPermission && !ActivityCompat.shouldShowRequestPermissionRationale(this,Manifest.permission.CAMERA)) {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())));
                } else { askedPermission=true; ActivityCompat.requestPermissions(this,new String[]{Manifest.permission.CAMERA},CAMERA_REQUEST); }
            } else {
                camera.disableView(); cameraReady=false;
                if(!initialized) initialized=(receivedDirectory.isDirectory() || receivedDirectory.mkdirs()) && NativeReceiver.initialize();
                permissionUiState=-1; startCamera(); updatePermissionUi();
            }
        }); permissionCard.addView(permissionButton);
        pauseButton.setEnabled(initialized && allowed);
    }
    private void startCamera() {
        if(initialized && resumed && !filesVisible && hasCameraPermission()) {
            camera.setCameraPermissionGranted(); cameraStartedAt=SystemClock.elapsedRealtime(); camera.enableView();
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }
    @Override public void onRequestPermissionsResult(int requestCode,String[] permissions,int[] results) {
        super.onRequestPermissionsResult(requestCode,permissions,results);
        if(requestCode==CAMERA_REQUEST) { updatePermissionUi(); startCamera(); }
    }
    @Override protected void onResume() { super.onResume(); resumed=true; stats.clear(); updatePermissionUi(); startCamera(); handler.post(tick); }
    @Override protected void onPause() {
        resumed=false; handler.removeCallbacks(tick); camera.disableView(); cameraReady=false; stats.clear();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); super.onPause();
    }
    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null); camera.disableView();
        if(initialized && !isChangingConfigurations()) NativeReceiver.reset();
        io.shutdown(); super.onDestroy();
    }
    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config); camera.disableView(); cameraReady=false; buildUi(); startCamera();
    }
    @Override public void onCameraViewStarted(int width,int height) { runOnUiThread(()->{cameraReady=true; updatePermissionUi(); syncZoom();}); }
    @Override public void onCameraViewStopped() { cameraReady=false; }
    @Override public Mat onCameraFrame(CameraBridgeViewBase.CvCameraViewFrame frame) {
        Mat mat=frame.rgba(); if(initialized && !paused) NativeReceiver.submit(mat.getNativeObjAddr(),receivedDirectory.getAbsolutePath(),mode); return mat;
    }
    private final Runnable tick=new Runnable() {
        @Override public void run() {
            if(!resumed) return;
            if(initialized) {
                snapshot=new ScanSnapshot(NativeReceiver.snapshot());
                long now=SystemClock.elapsedRealtime(); stats.update(now,snapshot,paused || filesVisible || !cameraReady);
                ScanGuidance.Hint candidate=ScanGuidance.choose(snapshot,stats,paused);
                if(candidate!=pendingHint) { pendingHint=candidate; hintSince=now; }
                if(now-hintSince>=550 || candidate==ScanGuidance.Hint.PAUSED || candidate==ScanGuidance.Hint.FINISHING) shownHint=candidate;
                renderStats();
                byte[] event;
                while((event=NativeReceiver.pollFile())!=null && event.length>0) received(new String(event,StandardCharsets.UTF_8));
                if(snapshot.errors>lastErrorCount) { lastErrorCount=snapshot.errors; new AlertDialog.Builder(MainActivity.this).setMessage(R.string.store_failed).setPositiveButton(R.string.done,null).show(); }
            }
            if(!cameraReady && cameraStartedAt>0 && SystemClock.elapsedRealtime()-cameraStartedAt>5000 && permissionCard.getVisibility()==View.VISIBLE) updatePermissionUi();
            handler.postDelayed(this,250);
        }
    };
    private void renderStats() {
        int label=switch(shownHint) {
            case PAUSED->R.string.status_paused; case LOST->R.string.status_lost; case STALLED->R.string.status_stalled;
            case RECEIVING->R.string.status_receiving; case FINISHING->R.string.status_finishing;
            case SEARCH,INCOMPLETE->R.string.status_search; default->R.string.status_located;
        };
        statusText.setText(label); statusText.setTextColor(color(this,shownHint==ScanGuidance.Hint.RECEIVING?R.color.success:R.color.text_primary));
        hintText.setText(hintResource(shownHint));
        speedText.setText(paused?"—":formatBytes((long)stats.bytesPerSecond)+"/s");
        qualityText.setText(stats.recognitionPercent<0?"—":stats.recognitionPercent+"%");
        progress.setProgress((int)(snapshot.progress*1000));
        progressText.setText(snapshot.streams>0?getString(R.string.progress_value,(int)(snapshot.progress*100))+" · "+getString(R.string.streams_format,snapshot.streams):getString(R.string.waiting_data));
        if(snapshot.streams>0 && snapshot.progress<.99 && stats.bytesPerSecond>1 && !paused) {
            long seconds=Math.max(1,(long)((snapshot.total-snapshot.received)/stats.bytesPerSecond));
            etaText.setText(getString(R.string.estimate,seconds<60?getString(R.string.seconds,seconds):getString(R.string.minutes,(seconds+59)/60)));
        } else etaText.setText(snapshot.finishing?getString(R.string.guide_finishing):snapshot.progress>=.99?getString(R.string.guide_last_data):getString(R.string.estimate_wait));
        overlay.update(snapshot,shownHint==ScanGuidance.Hint.RECEIVING,paused);
    }
    private int hintResource(ScanGuidance.Hint hint) {
        return switch(hint) {
            case INCOMPLETE->R.string.guide_incomplete; case LEFT->R.string.guide_left; case RIGHT->R.string.guide_right; case UP->R.string.guide_up; case DOWN->R.string.guide_down;
            case CLOSER->R.string.guide_closer; case FARTHER->R.string.guide_farther; case STRAIGHTEN->R.string.guide_straighten; case STEADY->R.string.guide_steady;
            case RECEIVING->R.string.guide_receiving; case STALLED->R.string.guide_stalled; case LOST->R.string.guide_lost; case FINISHING->R.string.guide_finishing; case PAUSED->R.string.guide_paused; default->R.string.guide_search;
        };
    }
    private void showModeDialog() {
        if(!initialized) return;
        int[] modes={0,68,67,66,4}; String[] names={getString(R.string.mode_auto),"B","Bm","Bu","4C"};
        int selected=0; for(int i=0;i<modes.length;i++) if(modes[i]==mode) selected=i;
        new AlertDialog.Builder(this).setTitle(R.string.mode_label).setSingleChoiceItems(names,selected,(dialog,which)->{
            dialog.dismiss(); if(modes[which]==mode) return;
            new AlertDialog.Builder(this).setMessage(R.string.mode_help).setNegativeButton(R.string.cancel,null).setPositiveButton(R.string.done,(d,w)->{
                camera.disableView(); NativeReceiver.reset(); mode=modes[which]; getPreferences(MODE_PRIVATE).edit().putInt("mode",mode).apply();
                stats.clear(); snapshot=new ScanSnapshot(null); lastErrorCount=0; startCamera();
            }).show();
        }).setNegativeButton(R.string.cancel,null).show();
    }
    private void showOptions() {
        new AlertDialog.Builder(this).setTitle(R.string.options).setItems(new String[]{getString(R.string.mode_label),getString(R.string.reset),getString(R.string.about)},(d,which)->{
            if(which==0) showModeDialog();
            else if(which==1) new AlertDialog.Builder(this).setTitle(R.string.reset_title).setMessage(R.string.reset_body).setNegativeButton(R.string.cancel,null).setPositiveButton(R.string.reset,(a,b)->{
                resetReception();
            }).show();
            else new AlertDialog.Builder(this).setTitle(R.string.about_title).setMessage(getString(R.string.help_body)+"\n\nCatio Receiver "+BuildConfig.VERSION_NAME+" · CameraFileCopy / libcimbar 0.6.8").setPositiveButton(R.string.done,null).setNeutralButton(R.string.licenses,(a,b)->showLicenses()).show();
        }).show();
    }
    private void resetReception() {
        if(!initialized) return;
        // Stop camera submissions and join native workers before discarding the session.
        // Keep saved files, but forget completed streams so they can be received again.
        paused=true;
        float zoom=camera.getZoomRatio();
        camera.disableView(); cameraReady=false; NativeReceiver.reset();
        stats.clear(); snapshot=new ScanSnapshot(null); lastErrorCount=0;
        shownHint=pendingHint=ScanGuidance.Hint.SEARCH; hintSince=SystemClock.elapsedRealtime();
        latestName=null; latestText.setText(""); latestText.setVisibility(View.GONE);
        paused=false; pauseButton.setText(R.string.pause); renderStats();
        startCamera(); camera.setZoomRatio(zoom); syncZoom(); updatePermissionUi();
        Toast.makeText(this,R.string.reset_done,Toast.LENGTH_SHORT).show();
    }
    private void showLicenses() {
        try(InputStream in=getAssets().open("catio_notices.txt")) {
            ByteArrayOutputStream out=new ByteArrayOutputStream(); byte[] buf=new byte[8192]; int n; while((n=in.read(buf))!=-1) out.write(buf,0,n);
            TextView text=text(this,out.toString("UTF-8"),12,R.color.text_primary,false); text.setPadding(dp(this,20),dp(this,16),dp(this,20),dp(this,16)); text.setTextIsSelectable(true);
            ScrollView scroll=new ScrollView(this); scroll.addView(text); new AlertDialog.Builder(this).setTitle(R.string.licenses).setView(scroll).setPositiveButton(R.string.done,null).show();
        } catch(IOException e) { Toast.makeText(this,R.string.open_failed,Toast.LENGTH_LONG).show(); }
    }
    private void received(String name) {
        File f=resolveReceived(name); if(f==null) return;
        latestName=name; latestText.setText(getString(R.string.received_detail,getString(R.string.received_title),name)); latestText.setVisibility(View.VISIBLE);
        latestText.announceForAccessibility(getString(R.string.received_title)+" "+name);
        if(filesVisible) renderFiles();
    }
    private void showFiles(boolean visible) {
        filesVisible=visible; center.setVisibility(visible?View.GONE:View.VISIBLE); library.setVisibility(visible?View.VISIBLE:View.GONE);
        int index=root.indexOfChild(navigation); root.removeView(navigation); navigation=navigation(this,visible?2:0,this::selectTab); root.addView(navigation,index);
        if(visible) { camera.disableView(); cameraReady=false; stats.clear(); getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); renderFiles(); }
        else { if(latestName!=null) { latestText.setText(getString(R.string.received_detail,getString(R.string.received_title),latestName)); latestText.setVisibility(View.VISIBLE); } startCamera(); }
    }
    private void syncZoom() {
        zoomControl.setEnabled(cameraReady && camera.getMaxZoomRatio()>1);
        zoomControl.setMax(Math.round((camera.getMaxZoomRatio()-1)*100));
        zoomControl.setProgress(Math.round((camera.getZoomRatio()-1)*100));
        zoomLabel.setText(String.format(Locale.ROOT,"%.1f×",camera.getZoomRatio()));
    }
    private void selectTab(int tab) {
        if(tab==1) startActivity(new Intent(this,WebViewActivity.class));
        else showFiles(tab==2);
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent); showFiles(intent.getIntExtra("tab",0)==2);
    }
    private void renderFiles() {
        library.removeAllViews();
        TextView title=text(this,getString(R.string.files_title),26,R.color.text_primary,true); title.setPadding(0,dp(this,14),0,dp(this,6)); library.addView(title);
        TextView desc=text(this,getString(R.string.files_description),12,R.color.text_secondary,false); desc.setPadding(0,0,0,dp(this,18)); library.addView(desc);
        File[] files=receivedDirectory.listFiles(f->f.isFile()&&!f.getName().startsWith("."));
        if(files==null) files=new File[0]; Arrays.sort(files,(a,b)->Long.compare(b.lastModified(),a.lastModified()));
        long total=0; for(File file:files) total+=file.length();
        LinearLayout summary=row(this); summary.setPadding(dp(this,16),dp(this,14),dp(this,16),dp(this,14)); summary.setBackground(surface(this,R.color.accent_soft,16));
        summary.addView(text(this,getString(R.string.file_count,files.length),13,R.color.accent,true),weight());
        summary.addView(text(this,formatBytes(total),13,R.color.accent,true)); library.addView(summary);
        ScrollView scroll=new ScrollView(this); scroll.setClipToPadding(false); scroll.setPadding(0,dp(this,6),0,dp(this,12));
        LinearLayout list=column(this); scroll.addView(list); library.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        if(files.length==0) {
            LinearLayout empty=column(this); empty.setGravity(Gravity.CENTER); empty.setPadding(dp(this,24),dp(this,50),dp(this,24),dp(this,24));
            empty.addView(new GlyphView(this,"files",R.color.accent),new LinearLayout.LayoutParams(dp(this,48),dp(this,48)));
            TextView label=text(this,getString(R.string.files_empty),17,R.color.text_primary,true); label.setPadding(0,dp(this,20),0,dp(this,8)); label.setGravity(Gravity.CENTER); empty.addView(label);
            TextView body=text(this,getString(R.string.files_empty_body),13,R.color.text_secondary,false); body.setGravity(Gravity.CENTER); empty.addView(body); list.addView(empty);
        }
        for(File file:files) {
            LinearLayout card=column(this); card.setPadding(dp(this,14),dp(this,16),dp(this,14),dp(this,12)); card.setBackground(surface(this,R.color.surface,18));
            LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2); p.topMargin=dp(this,10); list.addView(card,p);
            LinearLayout info=row(this); FrameLayout badge=new FrameLayout(this); badge.setBackground(surface(this,R.color.accent_soft,12));
            badge.addView(new GlyphView(this,"document",R.color.accent),new FrameLayout.LayoutParams(dp(this,24),dp(this,24),Gravity.CENTER)); info.addView(badge,new LinearLayout.LayoutParams(dp(this,44),dp(this,48)));
            LinearLayout labels=column(this); labels.setPadding(dp(this,12),0,dp(this,8),0);
            TextView name=text(this,file.getName(),14,R.color.text_primary,true); name.setMaxLines(2); name.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE); labels.addView(name);
            TextView detail=text(this,formatBytes(file.length())+" · "+DateFormat.getDateTimeInstance(DateFormat.SHORT,DateFormat.SHORT).format(new Date(file.lastModified())),11,R.color.text_secondary,false); detail.setPadding(0,dp(this,7),0,0); labels.addView(detail); info.addView(labels,weight());
            info.addView(iconButton(this,"more",getString(R.string.options)+" "+file.getName(),()->fileActions(file)),new LinearLayout.LayoutParams(dp(this,44),dp(this,44))); card.addView(info);
            info.setOnClickListener(v->openFile(file,false));
            LinearLayout actions=row(this); actions.setPadding(dp(this,56),dp(this,12),0,0);
            Button open=button(this,getString(R.string.open),false), save=button(this,getString(R.string.save),false);
            open.setTextColor(color(this,R.color.accent)); save.setTextColor(color(this,R.color.accent)); open.setTextSize(12); save.setTextSize(12);
            open.setOnClickListener(v->openFile(file,false)); save.setOnClickListener(v->exportFile(file)); actions.addView(open,weight());
            LinearLayout.LayoutParams sp=weight(); sp.leftMargin=dp(this,8); actions.addView(save,sp); card.addView(actions);
        }
    }
    private void fileActions(File file) {
        new AlertDialog.Builder(this).setTitle(file.getName()).setItems(new String[]{getString(R.string.open),getString(R.string.save),getString(R.string.share),getString(R.string.delete)},(d,w)->{
            if(w==0) openFile(file,false); else if(w==1) exportFile(file); else if(w==2) openFile(file,true);
            else new AlertDialog.Builder(this).setTitle(R.string.delete_title).setMessage(R.string.delete_body).setNegativeButton(R.string.cancel,null).setPositiveButton(R.string.delete,(a,b)->{
                if(!file.delete()) Toast.makeText(this,R.string.delete_failed,Toast.LENGTH_LONG).show(); renderFiles();
            }).show();
        }).show();
    }
    private File resolveReceived(String name) {
        if(name==null || name.contains("/") || name.contains("\\") || name.startsWith(".")) return null;
        File f=new File(receivedDirectory,name); return f.isFile()?f:null;
    }
    private void openFile(File file,boolean share) {
        try {
            Uri uri=FileProvider.getUriForFile(this,getPackageName()+".files",file);
            Intent intent=new Intent(share?Intent.ACTION_SEND:Intent.ACTION_VIEW).setType(getMimeType(file.getName())).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if(share) intent.putExtra(Intent.EXTRA_STREAM,uri); else intent.setDataAndType(uri,getMimeType(file.getName()));
            startActivity(Intent.createChooser(intent,getString(share?R.string.share:R.string.open)));
        } catch(ActivityNotFoundException|IllegalArgumentException e) { Toast.makeText(this,R.string.open_failed,Toast.LENGTH_LONG).show(); }
    }
    private void exportFile(File file) {
        if(exporting) return;
        pendingSave=file.getName();
        Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(getMimeType(file.getName())).putExtra(Intent.EXTRA_TITLE,file.getName());
        try { startActivityForResult(intent,CREATE_FILE); } catch(ActivityNotFoundException e) { pendingSave=null; Toast.makeText(this,R.string.export_failed,Toast.LENGTH_LONG).show(); }
    }
    @Override protected void onActivityResult(int code,int result,Intent data) {
        super.onActivityResult(code,result,data); if(code!=CREATE_FILE) return;
        File file=resolveReceived(pendingSave); pendingSave=null;
        if(result!=RESULT_OK || data==null || data.getData()==null) { Toast.makeText(this,R.string.export_cancelled,Toast.LENGTH_SHORT).show(); return; }
        if(file==null) { Toast.makeText(this,R.string.export_failed,Toast.LENGTH_LONG).show(); return; }
        exporting=true; Toast.makeText(this,R.string.exporting,Toast.LENGTH_SHORT).show(); Uri uri=data.getData();
        io.execute(()->{
            boolean success=false;
            try(InputStream in=new FileInputStream(file); OutputStream out=getContentResolver().openOutputStream(uri,"wt")) {
                if(out==null) throw new IOException(); byte[] buffer=new byte[65536]; int n; while((n=in.read(buffer))!=-1) out.write(buffer,0,n); out.flush(); success=true;
            } catch(IOException|SecurityException e) { /* Keep the received original for retry. */ }
            boolean ok=success; handler.post(()->{exporting=false; if(!isDestroyed()) Toast.makeText(this,ok?R.string.export_success:R.string.export_failed,Toast.LENGTH_LONG).show();});
        });
    }
    static String getMimeType(String name) {
        int i=name.lastIndexOf('.'); String mime=i<0?null:MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(i+1).toLowerCase(Locale.ROOT));
        return mime==null?"application/octet-stream":mime;
    }
    static String formatBytes(long bytes) {
        if(bytes<1024) return bytes+" B";
        if(bytes<1024*1024) return String.format(Locale.getDefault(),"%.1f KiB",bytes/1024.0);
        return String.format(Locale.getDefault(),"%.1f MiB",bytes/(1024.0*1024));
    }

}
