#pragma once
#include <stdarg.h>

// All storage is fixed and protected by sampleLock. The game thread never
// waits for readers. This journal describes sampled changes, not every native
// callback or decoded packet; a request ID is attached only to its own receipt.
namespace telemetry {
constexpr unsigned EventLimit = 64, CaptureLimit = 8, FrameLimit = 256, PageLimit = 16;
char instance[33];
DWORD bootTime, head, lastHeartbeat;
struct Event {
    DWORD id, time, epoch, sequence;
    int kind, phase, action, status, outcome, stop;
    bool pawn, owned;
    BYTE physics;
    char request[33];
};
const char* kinds[] = {"sample", "epoch_changed", "session_changed", "movement_changed", "physics_changed", "owner_changed"};
Event events[EventLimit];
Sample previous;
DWORD previousRevision;
bool previousWorld, previousOwner;
struct ReceiptState { int status, outcome, stop; bool seen; };
ReceiptState previousReceipts[session::ReceiptLimit];
struct Frame { DWORD time, epoch, sequence; Sample sample; };
struct Capture {
    char id[33];
    DWORD epoch, duration, began, ended, eventBegin, eventEnd, dropped;
    unsigned count;
    volatile LONG skipped;
    int state;
    Frame frames[FrameLimit];
};
const char* captureStates[] = {"recording", "deadline", "stopped", "epoch_changed"};
Capture captures[CaptureLimit];
unsigned captureCount;
volatile LONG active = -1;

struct Json {
    char* output; unsigned size, used; bool ok;
    Json(char* output, unsigned size) : output(output), size(size), used(0), ok(true) { output[0] = 0; }
    void Add(const char* format, ...) {
        if (!ok) return;
        va_list args; va_start(args, format);
        int n = _vsnprintf(output + used, size - used, format, args);
        va_end(args);
        if (n < 0 || static_cast<unsigned>(n) >= size - used) {
            strcpy(output, "{\"error\":\"telemetry_overflow\"}"); ok = false;
        } else used += n;
    }
};
void Identity(Json& json) {
    json.Add("\"protocol\":\"%s\",\"profile\":\"%s\",\"instance\":\"%s\",\"pid\":%lu",
        c4::Protocol, c4::Profile, instance, GetCurrentProcessId());
}
bool Initialize() {
    HCRYPTPROV provider = 0; BYTE bytes[16];
    if (!CryptAcquireContextA(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) return false;
    bool ok = CryptGenRandom(provider, sizeof(bytes), bytes) != 0;
    CryptReleaseContext(provider, 0);
    if (!ok) return false;
    for (unsigned i = 0; i < sizeof(bytes); ++i) _snprintf(instance + i * 2, 3, "%02x", bytes[i]);
    bootTime = GetTickCount();
    return true;
}
void Push(int kind, const Sample& next, const session::Receipt* receipt = nullptr) {
    // Exhaustion is explicit rather than allowing a wrapped cursor to look new.
    if (head == 0xffffffff) return;
    Event& event = events[head % EventLimit];
    event = {};
    event.id = ++head; event.kind = kind; event.time = next.time - bootTime;
    event.epoch = next.epoch; event.sequence = next.sequence;
    event.phase = session::published.phase; event.pawn = next.pawn != nullptr;
    event.owned = *session::owner != 0; event.physics = next.physics;
    if (receipt) {
        strcpy(event.request, receipt->id); event.action = receipt->action;
        event.status = receipt->status; event.outcome = receipt->outcome; event.stop = receipt->stopState;
    }
}
void Publish(const Sample& next) {
    if (!previous.sequence || next.time - lastHeartbeat >= 1000) {
        Push(0, next); lastHeartbeat = next.time;
    }
    if (!previous.sequence || previous.epoch != next.epoch) Push(1, next);
    if (!previous.sequence || previousRevision != session::published.revision
        || previousWorld != session::published.worldEntered) Push(2, next);
    for (unsigned i = 0; i < session::receiptCount; ++i) {
        const auto& receipt = session::receipts[i]; auto& before = previousReceipts[i];
        if (receipt.action >= session::MoveAction && (!before.seen || receipt.status != before.status
            || receipt.outcome != before.outcome || receipt.stopState != before.stop)) Push(3, next, &receipt);
        before = {receipt.status, receipt.outcome, receipt.stopState, true};
    }
    if (previous.pawn != next.pawn || previous.physics != next.physics) Push(4, next);
    bool owned = *session::owner != 0;
    if (previousOwner != owned) Push(5, next);
    previous = next; previousRevision = session::published.revision;
    previousWorld = session::published.worldEntered; previousOwner = owned;
}
void Finish(Capture& capture, int state, DWORD now) {
    capture.state = state; capture.ended = now; capture.eventEnd = head;
    InterlockedExchange(&active, -1);
}
void Refresh(DWORD now) {
    LONG index = InterlockedCompareExchange(&active, -1, -1);
    if (index >= 0 && now - captures[index].began >= captures[index].duration) Finish(captures[index], 1, now);
}
bool Active() { return InterlockedCompareExchange(&active, -1, -1) >= 0; }
void Skipped() {
    LONG index = InterlockedCompareExchange(&active, -1, -1);
    if (index >= 0) InterlockedIncrement(&captures[index].skipped);
}
void Record(const Sample& next) {
    Refresh(next.time);
    LONG index = InterlockedCompareExchange(&active, -1, -1);
    if (index < 0) return;
    Capture& capture = captures[index];
    if (capture.epoch != next.epoch) { Finish(capture, 3, next.time); return; }
    if (capture.count == FrameLimit) { ++capture.dropped; return; }
    Frame& frame = capture.frames[capture.count++];
    frame.time = next.time - bootTime; frame.epoch = next.epoch;
    frame.sequence = sample.sequence; frame.sample = next;
}
void RenderEvents(DWORD after, unsigned limit, Json& json) {
    DWORD oldest = head > EventLimit ? head - EventLimit + 1 : 1;
    DWORD first = after + 1 < oldest ? oldest : after + 1;
    DWORD gap = after + 1 < oldest ? oldest - after - 1 : 0;
    DWORD available = head >= first ? head - first + 1 : 0;
    unsigned count = available < limit ? available : limit;
    DWORD next = count ? first + count - 1 : after;
    json.Add("{"); Identity(json);
    json.Add(",\"source\":\"sampled_client_observations\",\"oldest\":%lu,\"head\":%lu,\"gap\":%lu,\"exhausted\":%s,\"hasMore\":%s,\"nextCursor\":{\"instance\":\"%s\",\"after\":%lu},\"events\":[",
        oldest, head, gap, head == 0xffffffff ? "true" : "false", next < head ? "true" : "false", instance, next);
    for (unsigned i = 0; i < count; ++i) {
        const Event& event = events[(first + i - 1) % EventLimit];
        json.Add("%s{\"sequence\":%lu,\"elapsedMs\":%lu,\"epoch\":%lu,\"sampleSequence\":%lu,\"kind\":\"%s\",\"phase\":\"%s\",\"pawnAvailable\":%s,\"physicsRaw\":%u,\"ownerActive\":%s,\"receipt\":",
            i ? "," : "", event.id, event.time, event.epoch, event.sequence, kinds[event.kind], session::phases[event.phase],
            event.pawn ? "true" : "false", event.physics, event.owned ? "true" : "false");
        if (*event.request) json.Add("{\"requestId\":\"%s\",\"action\":\"%s\",\"status\":\"%s\",\"outcome\":\"%s\",\"stop\":\"%s\"}",
            event.request, session::actions[event.action], session::statuses[event.status], session::outcomes[event.outcome], session::stopStates[event.stop]);
        else json.Add("null");
        json.Add("}");
    }
    json.Add("]}");
}
void RenderCapture(const Capture& capture, unsigned offset, unsigned limit, Json& json) {
    unsigned count = capture.count - offset;
    if (count > limit) count = limit;
    json.Add("{"); Identity(json);
    json.Add(",\"captureId\":\"%s\",\"epoch\":%lu,\"state\":\"%s\",\"durationMs\":%lu,\"beganMs\":%lu,\"endedMs\":",
        capture.id, capture.epoch, captureStates[capture.state], capture.duration, capture.began - bootTime);
    if (capture.state) json.Add("%lu", capture.ended - bootTime); else json.Add("null");
    json.Add(",\"eventBegin\":%lu,\"eventEnd\":%lu,\"count\":%u,\"droppedFrames\":%lu,\"lockSkippedFrames\":%ld,\"captureStage\":\"post_native_tick\",\"mapCompleteness\":\"unknown\",\"nextOffset\":%u,\"hasMore\":%s,\"frames\":[",
        capture.eventBegin, capture.state ? capture.eventEnd : head, capture.count, capture.dropped, capture.skipped,
        offset + count, offset + count < capture.count ? "true" : "false");
    for (unsigned i = 0; i < count; ++i) {
        const Frame& frame = capture.frames[offset + i]; const Sample& value = frame.sample;
        json.Add("%s{\"index\":%u,\"elapsedMs\":%lu,\"epoch\":%lu,\"publicationSequence\":%lu,\"level\":\"%p\",\"pawn\":",
            i ? "," : "", offset + i, frame.time, frame.epoch, frame.sequence, value.level);
        if (value.pawn) json.Add("{\"id\":\"%p\",\"origin\":[%.6f,%.6f,%.6f],\"velocity\":[%.6f,%.6f,%.6f],\"physicsRaw\":%u,\"headingRaw\":%d,\"radius\":%.6f,\"height\":%.6f}",
            value.pawn, value.origin.x, value.origin.y, value.origin.z, value.velocity.x, value.velocity.y, value.velocity.z,
            value.physics, value.heading, value.radius, value.height);
        else json.Add("null");
        json.Add("}");
    }
    json.Add("]}");
}
bool Rpc(const char* command, char* output, unsigned size) {
    if (strncmp(command, "events ", 7) && strncmp(command, "capture_", 8)) return false;
    Json json(output, size);
    char identity[34] = {}, id[34] = {}, extra = 0;
    unsigned long after = 0, epoch = 0, duration = 0;
    unsigned limit = 0, offset = 0;
    Refresh(GetTickCount());
    if (sscanf(command, "events %33s %lu %u %c", identity, &after, &limit, &extra) == 3) {
        if (strcmp(identity, instance)) json.Add("{\"error\":\"event_instance_mismatch\"}");
        else if (after > head || after == 0xffffffff || !limit || limit > PageLimit) json.Add("{\"error\":\"invalid_event_cursor\"}");
        else RenderEvents(after, limit, json);
        return true;
    }
    bool start = sscanf(command, "capture_start %33s %lu %lu %c", id, &epoch, &duration, &extra) == 3;
    bool stop = !start && sscanf(command, "capture_stop %33s %c", id, &extra) == 1;
    bool read = !start && !stop && sscanf(command, "capture_read %33s %u %u %c", id, &offset, &limit, &extra) == 3;
    if ((!start && !stop && !read) || !session::Hex(id, 32)) { json.Add("{\"error\":\"invalid_capture_request\"}"); return true; }
    Capture* capture = nullptr;
    for (unsigned i = 0; i < captureCount; ++i) if (!strcmp(captures[i].id, id)) capture = &captures[i];
    if (start && capture && (capture->epoch != epoch || capture->duration != duration)) json.Add("{\"error\":\"capture_conflict\"}");
    else if (start && !capture) {
        if (Active()) json.Add("{\"error\":\"capture_busy\"}");
        else if (captureCount == CaptureLimit) json.Add("{\"error\":\"capture_capacity\"}");
        else if (sample.epoch != epoch) json.Add("{\"error\":\"stale_epoch\"}");
        else if (!sample.sequence || GetTickCount() - sample.time >= 5000) json.Add("{\"error\":\"sample_stale\"}");
        else if (duration < 1000 || duration > 10000) json.Add("{\"error\":\"invalid_capture_duration\"}");
        else {
            capture = &captures[captureCount]; strcpy(capture->id, id);
            capture->epoch = epoch; capture->duration = duration; capture->began = GetTickCount(); capture->eventBegin = head;
            InterlockedExchange(&active, static_cast<LONG>(captureCount++));
            RenderCapture(*capture, 0, 0, json);
        }
    } else if (!capture) json.Add("{\"error\":\"capture_unknown\"}");
    else if (read && (offset > capture->count || !limit || limit > PageLimit)) json.Add("{\"error\":\"invalid_capture_offset\"}");
    else {
        if (stop && !capture->state) Finish(*capture, 2, GetTickCount());
        RenderCapture(*capture, read ? offset : 0, read ? limit : 0, json);
    }
    return true;
}
}
