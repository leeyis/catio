package org.cimbar.camerafilecopy;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.opencv.android.Utils;
import org.opencv.core.Mat;
import org.opencv.core.MatOfPoint2f;
import org.opencv.core.Point;
import org.opencv.core.Size;
import org.opencv.imgproc.Imgproc;
import java.io.*;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

/** Actual Catio WASM PNGs -> Android JNI/OpenCV/fountain/Zstd -> exact original bytes. */
@RunWith(AndroidJUnit4.class)
public class ReceiverInteropTest {
    private Context fixtureContext;
    private File directory;
    private boolean perspective;
    @Before public void setUp() {
        fixtureContext=InstrumentationRegistry.getInstrumentation().getContext();
        Context app=InstrumentationRegistry.getInstrumentation().getTargetContext();
        directory=new File(app.getCacheDir(),"interop-"+System.nanoTime());
        assertTrue(directory.mkdirs()); assertTrue(NativeReceiver.initialize()); NativeReceiver.reset();
    }
    @After public void tearDown() {
        NativeReceiver.reset();
        File[] files=directory.listFiles(); if(files!=null) for(File f:files) assertTrue(f.delete());
        assertTrue(directory.delete());
    }
    private byte[] bytes(InputStream in) throws IOException {
        try(InputStream stream=in; ByteArrayOutputStream out=new ByteArrayOutputStream()) {
            byte[] b=new byte[8192]; int n; while((n=stream.read(b))!=-1) out.write(b,0,n); return out.toByteArray();
        }
    }
    private ScanSnapshot submit(int index,int mode) throws Exception {
        Bitmap bitmap;
        try(InputStream in=fixtureContext.getAssets().open(String.format(java.util.Locale.ROOT,"interop/frame-%02d.png",index))) { bitmap=BitmapFactory.decodeStream(in); }
        assertNotNull(bitmap); Mat mat=new Mat(); Utils.bitmapToMat(bitmap,mat); bitmap.recycle();
        if(perspective) {
            MatOfPoint2f src=new MatOfPoint2f(new Point(0,0),new Point(mat.cols()-1,0),new Point(0,mat.rows()-1),new Point(mat.cols()-1,mat.rows()-1));
            MatOfPoint2f dst=new MatOfPoint2f(new Point(130,70),new Point(1240,130),new Point(80,1250),new Point(1260,1180));
            Mat transform=Imgproc.getPerspectiveTransform(src,dst), warped=new Mat();
            Imgproc.warpPerspective(mat,warped,transform,new Size(1360,1320));
            mat.release(); src.release(); dst.release(); transform.release(); mat=warped;
        }
        long previous=new ScanSnapshot(NativeReceiver.snapshot()).scanned;
        try { NativeReceiver.submit(mat.getNativeObjAddr(),directory.getAbsolutePath(),mode); } finally { mat.release(); }
        long deadline=SystemClock.elapsedRealtime()+10000;
        ScanSnapshot s;
        do { SystemClock.sleep(50); s=new ScanSnapshot(NativeReceiver.snapshot()); } while(s.scanned<=previous && SystemClock.elapsedRealtime()<deadline);
        assertTrue("Scanner should finish",s.scanned>previous);
        // scanned is incremented before ECC/fountain work; settle the single submitted image.
        SystemClock.sleep(600);
        return new ScanSnapshot(NativeReceiver.snapshot());
    }
    private void assertRoundTrip(int mode,boolean duplicates) throws Exception { assertRoundTrip(mode,duplicates,"Catio-互通验证-🐈.bin"); }
    private void assertRoundTrip(int mode,boolean duplicates,String expectedName) throws Exception {
        ScanSnapshot first=submit(0,mode);
        if(mode==0) for(int n=0;n<7 && first.decoded==0;n++) first=submit(0,mode);
        assertTrue("Actual Catio frame must decode",first.decoded>0);
        assertTrue(first.uniqueBytes>0); assertEquals(4,first.anchors);
        if(duplicates) {
            long unique=first.uniqueBytes;
            for(int n=0;n<3;n++) submit(0,mode);
            assertEquals("Duplicate frames must not inflate goodput",unique,new ScanSnapshot(NativeReceiver.snapshot()).uniqueBytes);
        }
        byte[] event=NativeReceiver.pollFile();
        for(int frame=1;frame<12 && event.length==0;frame++) { submit(frame,mode); event=NativeReceiver.pollFile(); }
        assertTrue("A complete file must be published",event.length>0);
        String name=new String(event,StandardCharsets.UTF_8);
        assertEquals(expectedName,name);
        assertArrayEquals(bytes(fixtureContext.getAssets().open("interop/expected.bin")),bytes(new FileInputStream(new File(directory,name))));
        assertEquals(1,new ScanSnapshot(NativeReceiver.snapshot()).completed);
    }
    @Test public void overloadStaysBoundedAndRecoveryStillCompletes() throws Exception {
        Bitmap bitmap;
        try(InputStream in=fixtureContext.getAssets().open("interop/frame-00.png")) { bitmap=BitmapFactory.decodeStream(in); }
        Mat mat=new Mat(); Utils.bitmapToMat(bitmap,mat); bitmap.recycle();
        try {
            for(int n=0;n<80;n++) NativeReceiver.submit(mat.getNativeObjAddr(),directory.getAbsolutePath(),68);
            assertTrue("Keep no more than workers plus one queued frame",NativeReceiver.snapshot()[21]<=5);
        } finally { mat.release(); }
        SystemClock.sleep(1500);
        assertRoundTrip(68,false);
    }
    @Test public void softwareDecodeBenchmarkExcludesCameraAndChecksBytes() throws Exception {
        Mat[] frames=new Mat[12];
        for(int i=0;i<12;i++) {
            try(InputStream in=fixtureContext.getAssets().open(String.format(java.util.Locale.ROOT,"interop/frame-%02d.png",i))) {
                Bitmap b=BitmapFactory.decodeStream(in); frames[i]=new Mat(); Utils.bitmapToMat(b,frames[i]); b.recycle();
            }
        }
        long start=SystemClock.elapsedRealtime(); byte[] event=new byte[0]; int i=0;
        try {
            while(event.length==0 && SystemClock.elapsedRealtime()-start<20000) {
                NativeReceiver.submit(frames[i++%12].getNativeObjAddr(),directory.getAbsolutePath(),68);
                SystemClock.sleep(34); event=NativeReceiver.pollFile();
            }
            long elapsed=SystemClock.elapsedRealtime()-start;
            assertTrue("Software loopback should complete",event.length>0);
            String name=new String(event,StandardCharsets.UTF_8);
            byte[] original=bytes(fixtureContext.getAssets().open("interop/expected.bin"));
            assertArrayEquals(original,bytes(new FileInputStream(new File(directory,name))));
            android.os.Bundle result=new android.os.Bundle();
            result.putString("stream","Software-only loopback: "+original.length+" bytes in "+elapsed+" ms; camera excluded.\n");
            InstrumentationRegistry.getInstrumentation().sendStatus(0,result);
        } finally { for(Mat frame:frames) frame.release(); }
    }
    @Test public void desktopFramesRoundTripAndDuplicatesAreNotCounted() throws Exception { assertRoundTrip(68,true); }
    @Test public void receivingAgainDoesNotOverwriteTheExistingFile() throws Exception {
        assertRoundTrip(68,false); NativeReceiver.reset();
        assertRoundTrip(68,false,"Catio-互通验证-🐈 (1).bin");
        assertEquals(2,directory.listFiles().length);
    }
    @Test public void perspectiveFramesRecoverTheExactFile() throws Exception { perspective=true; assertRoundTrip(0,false); }
    @Test public void automaticModeFindsCatioAndPreservesUnicodeName() throws Exception { assertRoundTrip(0,false); }
}
