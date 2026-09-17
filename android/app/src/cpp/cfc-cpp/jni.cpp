#include "MultiThreadedDecoder.h"
#include <jni.h>
#include <memory>
#include <mutex>
namespace {
std::shared_ptr<MultiThreadedDecoder> receiver;
std::mutex receiverMutex;
int requestedMode = -1;
std::shared_ptr<MultiThreadedDecoder> current() {
    std::lock_guard<std::mutex> guard(receiverMutex); return receiver;
}
}
extern "C" {
JNIEXPORT void JNICALL Java_org_cimbar_camerafilecopy_NativeReceiver_submit(JNIEnv* env, jclass, jlong address, jstring directory, jint mode) {
    if (!address || !directory || (mode != 0 && mode != 4 && mode != 66 && mode != 67 && mode != 68)) return;
    const char* chars = env->GetStringUTFChars(directory, nullptr);
    if (!chars) return;
    std::string path(chars); env->ReleaseStringUTFChars(directory, chars);
    std::shared_ptr<MultiThreadedDecoder> proc;
    {
        std::lock_guard<std::mutex> guard(receiverMutex);
        if (!receiver || (requestedMode != mode && !receiver->set_mode(mode))) {
            if (receiver) receiver->stop();
            receiver = std::make_shared<MultiThreadedDecoder>(path, mode);
        }
        requestedMode = mode;
        if (mode == 0 && receiver->mode() == 0 && receiver->detected_mode()) {
            int detected = receiver->detected_mode();
            if (!receiver->set_mode(detected)) {
                receiver->stop(); receiver = std::make_shared<MultiThreadedDecoder>(path, detected);
            }
        }
        proc = receiver;
    }
    proc->add(*reinterpret_cast<cv::Mat*>(address));
}
JNIEXPORT jdoubleArray JNICALL Java_org_cimbar_camerafilecopy_NativeReceiver_snapshot(JNIEnv* env, jclass) {
    auto proc = current();
    std::array<double, 27> data{};
    if (proc) data = proc->snapshot();
    jdoubleArray result = env->NewDoubleArray(data.size());
    if (result) env->SetDoubleArrayRegion(result, 0, data.size(), data.data());
    return result;
}
JNIEXPORT jbyteArray JNICALL Java_org_cimbar_camerafilecopy_NativeReceiver_pollFile(JNIEnv* env, jclass) {
    auto proc = current();
    std::string name = proc ? proc->poll() : "";
    jbyteArray result = env->NewByteArray(name.size());
    if (result && !name.empty()) env->SetByteArrayRegion(result, 0, name.size(), reinterpret_cast<const jbyte*>(name.data()));
    return result;
}
JNIEXPORT void JNICALL Java_org_cimbar_camerafilecopy_NativeReceiver_reset(JNIEnv*, jclass) {
    std::shared_ptr<MultiThreadedDecoder> previous;
    { std::lock_guard<std::mutex> guard(receiverMutex); previous = std::move(receiver); requestedMode = -1; }
    if (previous) previous->stop();
}
}
