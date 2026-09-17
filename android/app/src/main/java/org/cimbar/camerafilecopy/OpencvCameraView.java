package org.cimbar.camerafilecopy;

import java.util.List;
import java.util.Collections;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.hardware.Camera;
import android.hardware.Camera.PreviewCallback;
import android.os.Build;
import android.util.AttributeSet;
import android.util.Log;
import android.view.Surface;
import android.view.ViewGroup.LayoutParams;
import android.view.WindowManager;

import org.opencv.android.CameraBridgeViewBase;
import org.opencv.core.Core;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.Size;
import org.opencv.imgproc.Imgproc;

/**
 * This class is an implementation of the Bridge View between OpenCV and Java Camera.
 * This class relays on the functionality available in base class and only implements
 * required functions:
 * connectCamera - opens Java camera and sets the PreviewCallback to be delivered.
 * disconnectCamera - closes the camera and stops preview.
 * When frame is delivered via callback from Camera - it processed via OpenCV to be
 * converted to RGBA32 and then passed to the external callback for modifications if required.
 */
public class OpencvCameraView extends CameraBridgeViewBase implements PreviewCallback {

    private static final int MAGIC_TEXTURE_ID = 10;
    private static final String TAG = "JavaCameraView";

    private byte mBuffer[];
    private Mat[] mFrameChain;
    private int mChainIdx = 0;
    private Thread mThread;
    private volatile boolean mStopThread;

    protected Camera mCamera;
    protected RotatedCameraFrame[] mCameraFrame;
    private SurfaceTexture mSurfaceTexture;
    private int mPreviewFormat = ImageFormat.NV21;

    public static class JavaCameraSizeAccessor implements ListItemAccessor {

        @Override
        public int getWidth(Object obj) {
            Camera.Size size = (Camera.Size) obj;
            return size.width;
        }

        @Override
        public int getHeight(Object obj) {
            Camera.Size size = (Camera.Size) obj;
            return size.height;
        }
    }

    public OpencvCameraView(Context context, int cameraId) {
        super(context, cameraId);
    }

    public OpencvCameraView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    private final Handler focusHandler = new Handler(Looper.getMainLooper());
    private int frameRotationDegrees;
    private long lastFocusAt;
    private int focusGeneration;
    private volatile float zoomRatio = 1f;
    private volatile float maxZoomRatio = 1f;
    public float getZoomRatio() { return zoomRatio; }
    public float getMaxZoomRatio() { return maxZoomRatio; }

    public void setZoomRatio(float value) {
        synchronized (this) {
            if (mCamera == null || (Float.isNaN(value) || Float.isInfinite(value))) return;
            try {
                Camera.Parameters p = mCamera.getParameters();
                if (!p.isZoomSupported()) return;
                int index = CameraControls.nearestZoom(p.getZoomRatios(), value);
                if (index == p.getZoom()) return;
                mCamera.cancelAutoFocus(); focusGeneration++;
                p.setZoom(index); setContinuousFocus(p);
                mCamera.setParameters(p);
                zoomRatio = p.getZoomRatios().get(index) / 100f;
            } catch (RuntimeException ignored) { }
        }
    }
    private void setContinuousFocus(Camera.Parameters p) {
        List<String> modes = p.getSupportedFocusModes();
        if (modes == null) return;
        if (modes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
        else if (modes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO)) p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO);
        if (p.getMaxNumFocusAreas() > 0) p.setFocusAreas(null);
        if (p.getMaxNumMeteringAreas() > 0) p.setMeteringAreas(null);
    }
    private void restoreFocus(Camera expected, int generation) {
        synchronized (this) {
            if (mCamera != expected || focusGeneration != generation) return;
            focusGeneration++;
            try { expected.cancelAutoFocus(); Camera.Parameters p = expected.getParameters(); setContinuousFocus(p); expected.setParameters(p); }
            catch (RuntimeException ignored) { }
        }
    }
    public void refocus() { focusAt(getWidth()/2f, getHeight()/2f); }
    public void focusAt(float viewX, float viewY) {
        synchronized (this) {
            if (mCamera == null || mFrameWidth <= 0 || mFrameHeight <= 0 || SystemClock.elapsedRealtime()-lastFocusAt < 700) return;
            float scale = Math.min((float)getWidth()/mFrameWidth, (float)getHeight()/mFrameHeight);
            float x = (viewX-(getWidth()-mFrameWidth*scale)/2)/(mFrameWidth*scale);
            float y = (viewY-(getHeight()-mFrameHeight*scale)/2)/(mFrameHeight*scale);
            if (x<0 || x>1 || y<0 || y>1) return;
            try {
                Camera.Parameters p = mCamera.getParameters();
                List<String> modes = p.getSupportedFocusModes();
                if (modes == null || !modes.contains(Camera.Parameters.FOCUS_MODE_AUTO)) return;
                float[] point = CameraControls.sensorPoint(x,y,frameRotationDegrees);
                int left=Math.max(-1000,Math.min(700,(int)point[0]-150)), top=Math.max(-1000,Math.min(700,(int)point[1]-150));
                List<Camera.Area> area=Collections.singletonList(new Camera.Area(new Rect(left,top,left+300,top+300),1000));
                mCamera.cancelAutoFocus(); p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
                if (p.getMaxNumFocusAreas()>0) p.setFocusAreas(area);
                if (p.getMaxNumMeteringAreas()>0) p.setMeteringAreas(area);
                mCamera.setParameters(p); lastFocusAt=SystemClock.elapsedRealtime();
                int generation=++focusGeneration; Camera expected=mCamera;
                mCamera.autoFocus((success,camera)->focusHandler.postDelayed(()->restoreFocus(camera,generation),700));
                // Some camera HALs never deliver a callback; do not leave focus locked.
                focusHandler.postDelayed(()->restoreFocus(expected,generation),3000);
            } catch (RuntimeException ignored) { if (mCamera!=null) restoreFocus(mCamera,focusGeneration); }
        }
    }

    protected Size bestCameraFrameSize(List<?> supportedSizes, ListItemAccessor accessor, int surfaceWidth, int surfaceHeight) {
        int calcWidth = 10000000;
        int calcHeight = 10000000;

        // Decode at sensor resolution, independent of a small portrait preview surface.
        int maxAllowedWidth = mMaxWidth == MAX_UNSPECIFIED ? 1920 : mMaxWidth;
        int maxAllowedHeight = mMaxHeight == MAX_UNSPECIFIED ? 1920 : mMaxHeight;

        for (Object size : supportedSizes) {
            int width = accessor.getWidth(size);
            int height = accessor.getHeight(size);
            int minDim = Math.min(width, height);
            if (minDim < 960 || minDim > 1080)
                continue;

            if (width <= maxAllowedWidth && height <= maxAllowedHeight) {
                if (width < calcWidth && height <= calcHeight) {
                    calcWidth = (int) width;
                    calcHeight = (int) height;
                }
            }
        }
        if (calcWidth < 10000000 && calcHeight < 10000000) {
            return new Size(calcWidth, calcHeight);
        }
        // else
        return calculateCameraFrameSize(supportedSizes, accessor, maxAllowedWidth, maxAllowedHeight);
    }

    protected boolean initializeCamera(int width, int height) {
        Log.d(TAG, "Initialize java camera");
        boolean result = true;
        synchronized (this) {
            mCamera = null;
            if (mSurfaceTexture != null) { mSurfaceTexture.release(); mSurfaceTexture = null; }
            int cameraId = -1;

            if (mCameraIndex == CAMERA_ID_ANY) {
                boolean connected = false;
                for (int camIdx = 0; camIdx < Camera.getNumberOfCameras(); ++camIdx) {
                    Log.d(TAG, "Trying to open camera with new open(" + Integer.valueOf(camIdx) + ")");
                    try {
                        mCamera = Camera.open(camIdx);
                        connected = true;
                        cameraId = camIdx;
                    } catch (RuntimeException e) {
                        Log.e(TAG, "Camera #" + camIdx + "failed to open: " + e.getLocalizedMessage());
                    }
                    if (connected) break;
                }
            } else {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.GINGERBREAD) {
                    int localCameraIndex = mCameraIndex;
                    if (mCameraIndex == CAMERA_ID_BACK) {
                        Log.i(TAG, "Trying to open back camera");
                        Camera.CameraInfo cameraInfo = new Camera.CameraInfo();
                        for (int camIdx = 0; camIdx < Camera.getNumberOfCameras(); ++camIdx) {
                            Camera.getCameraInfo( camIdx, cameraInfo );
                            if (cameraInfo.facing == Camera.CameraInfo.CAMERA_FACING_BACK) {
                                localCameraIndex = camIdx;
                                break;
                            }
                        }
                    } else if (mCameraIndex == CAMERA_ID_FRONT) {
                        Log.i(TAG, "Trying to open front camera");
                        Camera.CameraInfo cameraInfo = new Camera.CameraInfo();
                        for (int camIdx = 0; camIdx < Camera.getNumberOfCameras(); ++camIdx) {
                            Camera.getCameraInfo( camIdx, cameraInfo );
                            if (cameraInfo.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
                                localCameraIndex = camIdx;
                                break;
                            }
                        }
                    }
                    if (localCameraIndex == CAMERA_ID_BACK) {
                        Log.e(TAG, "Back camera not found!");
                    } else if (localCameraIndex == CAMERA_ID_FRONT) {
                        Log.e(TAG, "Front camera not found!");
                    } else {
                        Log.d(TAG, "Trying to open camera with new open(" + Integer.valueOf(localCameraIndex) + ")");
                        try {
                            mCamera = Camera.open(localCameraIndex);
                            cameraId = localCameraIndex;
                        } catch (RuntimeException e) {
                            Log.e(TAG, "Camera #" + localCameraIndex + "failed to open: " + e.getLocalizedMessage());
                        }
                    }
                }
            }

            if (mCamera == null)
                return false;

            android.hardware.Camera.CameraInfo info = new android.hardware.Camera.CameraInfo();
            android.hardware.Camera.getCameraInfo(cameraId, info);
            int frameRotation = getFrameRotation(
                    info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT,
                    info.orientation);
            frameRotationDegrees = frameRotation;
            /* Now set camera parameters */
            try {
                Camera.Parameters params = mCamera.getParameters();
                Log.d(TAG, "getSupportedPreviewSizes()");
                List<android.hardware.Camera.Size> sizes = params.getSupportedPreviewSizes();

                if (sizes != null) {
                    /* Select the size that fits surface considering maximum size allowed */
                    Size frameSize = bestCameraFrameSize(sizes, new JavaCameraSizeAccessor(), width, height);

                    /* Image format NV21 causes issues in the Android emulators */
                    if (Build.FINGERPRINT.startsWith("generic")
                            || Build.FINGERPRINT.startsWith("unknown")
                            || Build.MODEL.contains("google_sdk")
                            || Build.MODEL.contains("Emulator")
                            || Build.MODEL.contains("Android SDK built for x86")
                            || Build.MANUFACTURER.contains("Genymotion")
                            || (Build.BRAND.startsWith("generic") && Build.DEVICE.startsWith("generic"))
                            || "google_sdk".equals(Build.PRODUCT))
                        params.setPreviewFormat(ImageFormat.YV12);  // "generic" or "android" = android emulator
                    else
                        params.setPreviewFormat(ImageFormat.NV21);

                    mPreviewFormat = params.getPreviewFormat();

                    Log.d(TAG, "Set preview size to " + Integer.valueOf((int)frameSize.width) + "x" + Integer.valueOf((int)frameSize.height));
                    params.setPreviewSize((int)frameSize.width, (int)frameSize.height);

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.ICE_CREAM_SANDWICH && !android.os.Build.MODEL.equals("GT-I9100"))
                        params.setRecordingHint(true);

                    int[] originalFps = new int[2]; params.getPreviewFpsRange(originalFps);
                    String originalFocus = params.getFocusMode();
                    setContinuousFocus(params);
                    // Prefer a steady 30+ fps range, rather than a low-light 7–30 fps default.
                    int[] bestFps = null;
                    for (int[] fps : params.getSupportedPreviewFpsRange()) {
                        if (fps[0] >= 30000 && fps[1] <= 60000 && (bestFps == null || fps[1] > bestFps[1])) bestFps = fps;
                    }
                    if (bestFps != null) params.setPreviewFpsRange(bestFps[0], bestFps[1]);
                    if (params.isZoomSupported()) {
                        maxZoomRatio = Math.min(4f, params.getZoomRatios().get(params.getMaxZoom()) / 100f);
                        params.setZoom(CameraControls.nearestZoom(params.getZoomRatios(),zoomRatio));
                        zoomRatio = params.getZoomRatios().get(params.getZoom()) / 100f;
                    } else { maxZoomRatio=1; zoomRatio=1; }

                    try { mCamera.setParameters(params); }
                    catch (RuntimeException unsupportedCombination) {
                        // A HAL may advertise 60 fps yet reject it at this resolution.
                        params.setPreviewFpsRange(originalFps[0], originalFps[1]);
                        if (originalFocus != null) params.setFocusMode(originalFocus);
                        mCamera.setParameters(params);
                    }
                    params = mCamera.getParameters();

                    int rawFrameWidth = params.getPreviewSize().width;
                    int rawFrameHeight = params.getPreviewSize().height;

                    if (frameRotation % 180 == 0) {
                        mFrameWidth = params.getPreviewSize().width;
                        mFrameHeight = params.getPreviewSize().height;
                    } else {
                        mFrameWidth = params.getPreviewSize().height;
                        mFrameHeight = params.getPreviewSize().width;
                    }

                    if ((getLayoutParams().width == LayoutParams.MATCH_PARENT) && (getLayoutParams().height == LayoutParams.MATCH_PARENT))
                        mScale = Math.min(((float)height)/mFrameHeight, ((float)width)/mFrameWidth);
                    else
                        mScale = 0;

                    if (mFpsMeter != null) {
                        mFpsMeter.setResolution(mFrameWidth, mFrameHeight);
                    }

                    int size = mFrameWidth * mFrameHeight;
                    size  = size * ImageFormat.getBitsPerPixel(params.getPreviewFormat()) / 8;
                    mBuffer = new byte[size];

                    mCamera.addCallbackBuffer(mBuffer);
                    mCamera.setPreviewCallbackWithBuffer(this);

                    mFrameChain = new Mat[2];
                    mFrameChain[0] = new Mat(rawFrameHeight + (rawFrameHeight/2), rawFrameWidth, CvType.CV_8UC1);
                    mFrameChain[1] = new Mat(rawFrameHeight + (rawFrameHeight/2), rawFrameWidth, CvType.CV_8UC1);

                    AllocateCache();

                    mCameraFrame = new RotatedCameraFrame[2];
                    mCameraFrame[0] = new RotatedCameraFrame(new JavaCameraFrame(mFrameChain[0], rawFrameWidth, rawFrameHeight), frameRotation);
                    mCameraFrame[1] = new RotatedCameraFrame(new JavaCameraFrame(mFrameChain[1], rawFrameWidth, rawFrameHeight), frameRotation);

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.HONEYCOMB) {
                        mSurfaceTexture = new SurfaceTexture(MAGIC_TEXTURE_ID);
                        mCamera.setPreviewTexture(mSurfaceTexture);
                    } else
                        mCamera.setPreviewDisplay(null);

                    /* Finally we are ready to start the preview */
                    Log.d(TAG, "startPreview");
                    mCamera.startPreview();
                }
                else
                    result = false;
            } catch (Exception e) {
                result = false;
                e.printStackTrace();
            }
        }

        return result;
    }

    protected void releaseCamera() {
        synchronized (this) {
            focusGeneration++; focusHandler.removeCallbacksAndMessages(null);
            if (mCamera != null) {
                mCamera.stopPreview();
                mCamera.setPreviewCallback(null);

                mCamera.release();
            }
            mCamera = null;
            if (mFrameChain != null) {
                mFrameChain[0].release();
                mFrameChain[1].release();
            }
            if (mCameraFrame != null) {
                mCameraFrame[0].mFrame.release();
                mCameraFrame[0].release();
                mCameraFrame[1].mFrame.release();
                mCameraFrame[1].release();
            }
            if (mSurfaceTexture != null) { mSurfaceTexture.release(); mSurfaceTexture = null; }
        }
    }

    private boolean mCameraFrameReady = false;

    @Override
    protected boolean connectCamera(int width, int height) {

        /* 1. We need to instantiate camera
         * 2. We need to start thread which will be getting frames
         */
        /* First step - initialize camera connection */
        Log.d(TAG, "Connecting to camera");
        if (!initializeCamera(width, height))
            return false;

        mCameraFrameReady = false;

        /* now we can start update thread */
        Log.d(TAG, "Starting processing thread");
        mStopThread = false;
        mThread = new Thread(new CameraWorker());
        mThread.start();

        return true;
    }

    @Override
    protected void disconnectCamera() {
        /* 1. We need to stop thread which updating the frames
         * 2. Stop camera and release it
         */
        Log.d(TAG, "Disconnecting from camera");
        try {
            mStopThread = true;
            Log.d(TAG, "Notify thread");
            synchronized (this) {
                this.notify();
            }
            Log.d(TAG, "Waiting for thread");
            if (mThread != null)
                mThread.join();
        } catch (InterruptedException e) {
            e.printStackTrace();
        } finally {
            mThread =  null;
        }

        /* Now release camera */
        releaseCamera();

        mCameraFrameReady = false;
    }

    @Override
    public void onPreviewFrame(byte[] frame, Camera arg1) {
        synchronized (this) {
            mFrameChain[mChainIdx].put(0, 0, frame);
            mCameraFrameReady = true;
            this.notify();
        }
        if (mCamera != null)
            mCamera.addCallbackBuffer(mBuffer);
    }

    private class JavaCameraFrame implements CvCameraViewFrame {
        @Override
        public Mat gray() {
            return mYuvFrameData.submat(0, mHeight, 0, mWidth);
        }

        @Override
        public Mat rgba() {
            if (mPreviewFormat == ImageFormat.NV21)
                Imgproc.cvtColor(mYuvFrameData, mRgba, Imgproc.COLOR_YUV2RGBA_NV21, 4);
            else if (mPreviewFormat == ImageFormat.YV12)
                Imgproc.cvtColor(mYuvFrameData, mRgba, Imgproc.COLOR_YUV2RGB_I420, 4);  // COLOR_YUV2RGBA_YV12 produces inverted colors
            else
                throw new IllegalArgumentException("Preview Format can be NV21 or YV12");

            return mRgba;
        }

        public JavaCameraFrame(Mat Yuv420sp, int width, int height) {
            super();
            mWidth = width;
            mHeight = height;
            mYuvFrameData = Yuv420sp;
            mRgba = new Mat();
        }

        @Override
        public void release() {
            mRgba.release();
        }

        private Mat mYuvFrameData;
        private Mat mRgba;
        private int mWidth;
        private int mHeight;
    };

    private class CameraWorker implements Runnable {

        @Override
        public void run() {
            do {
                boolean hasFrame = false;
                synchronized (OpencvCameraView.this) {
                    try {
                        while (!mCameraFrameReady && !mStopThread) {
                            OpencvCameraView.this.wait();
                        }
                    } catch (InterruptedException e) {
                        e.printStackTrace();
                    }
                    if (mCameraFrameReady)
                    {
                        mChainIdx = 1 - mChainIdx;
                        mCameraFrameReady = false;
                        hasFrame = true;
                    }
                }

                if (!mStopThread && hasFrame) {
                    if (!mFrameChain[1 - mChainIdx].empty())
                        deliverAndDrawFrame(mCameraFrame[1 - mChainIdx]);
                }
            } while (!mStopThread);
            Log.d(TAG, "Finish processing thread");
        }
    }
}
