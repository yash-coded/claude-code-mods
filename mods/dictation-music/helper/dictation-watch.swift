// Prints "start <app>" when an app begins capturing the microphone and
// "stop <app>" when it ends. <app> is the bundle ID, or the process name for
// apps without one. Needs macOS 14.2+ (Core Audio process objects).
import CoreAudio
import Darwin
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func processObjects() -> [AudioObjectID] {
  var addr = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

func name(_ id: AudioObjectID) -> String? {
  var addr = address(kAudioProcessPropertyBundleID)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  if AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr,
     let bundle = value?.takeRetainedValue() as String?, !bundle.isEmpty {
    return bundle
  }
  var pidAddr = address(kAudioProcessPropertyPID)
  var pid: pid_t = 0
  var pidSize = UInt32(MemoryLayout<pid_t>.size)
  guard AudioObjectGetPropertyData(id, &pidAddr, 0, nil, &pidSize, &pid) == noErr else { return nil }
  var buffer = [CChar](repeating: 0, count: 256)
  return proc_name(pid, &buffer, 256) > 0 ? String(cString: buffer) : nil
}

func isCapturing(_ id: AudioObjectID) -> Bool {
  var addr = address(kAudioProcessPropertyIsRunningInput)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr && value != 0
}

var capturing = Set<String>()
print("ready")
while true {
  let now = Set(processObjects().filter(isCapturing).compactMap(name))
  for app in capturing.subtracting(now).sorted() { print("stop \(app)") }
  for app in now.subtracting(capturing).sorted() { print("start \(app)") }
  capturing = now
  // Exit with the session that started us.
  if getppid() == 1 { exit(0) }
  usleep(150_000)
}
