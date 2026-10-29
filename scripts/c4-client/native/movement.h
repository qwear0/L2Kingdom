#pragma once

// Included inside session after its fixed receipt/owner storage. Movement never
// writes a transform or fabricates ValidatePosition: the native request is
// followed by the original server echo -> AddMoveTo -> client physics path.
using NativeMove = void (__thiscall*)(void*, void*, Vector, Vector, void*, int);
using NativeStop = void (__thiscall*)(void*);
NativeMove nativeMove;
NativeStop nativeStop;
void** playerControllerTable;
int foreground = -1, lastMovement = -1;
volatile LONG manualPending;
const char* outcomes[] = {"not_observed", "pending", "moving", "reached_xy_stopped", "stopped", "stalled", "timed_out", "interrupted", "world_lost", "manual_override", "unknown"};
const char* stopStates[] = {"not_requested", "pending", "dispatched", "observed_stopped", "unconfirmed"};
void EndOwner();

float Distance2(Vector a, Vector b) {
    float x = a.x - b.x, y = a.y - b.y, z = a.z - b.z;
    return x * x + y * y + z * z;
}
bool LocalDestination(Vector from, Vector to) {
    float x = from.x - to.x, y = from.y - to.y, z = from.z - to.z;
    return Finite(to) && x * x + y * y <= 512.0f * 512.0f && z >= -256 && z <= 256;
}
bool MovementReady(const Sample& next) {
    // This predicate also runs on the RPC worker: copied values/opaque identity
    // comparisons only. Live object checks belong to CheckedController below.
    return next.pawn && next.viewportActor && next.physics == 1;
}
void* CheckedController(void* engine, void* controller, void* pawn) {
    void* viewport = PointerAt(PointerAt(PointerAt(engine, 0x58), 0x38), 0);
    if (GetCurrentThreadId() != gameThread || !Handler(engine)
        || PointerAt(viewport, 0x3c) != controller
        || !Readable(controller, 0xa7c) || PointerAt(controller, 0) != playerControllerTable
        || PointerAt(controller, c4::ControllerPawn) != pawn || !Readable(pawn, 0x1488)
        || PointerAt(pawn, c4::PawnController) != controller || !isA(pawn, pawnClass)
        || getLevel(pawn) != getLevel(controller)) return nullptr;
    return controller;
}
bool StopOutstanding() {
    return foreground >= 0 && receipts[foreground].stopState > 0 && receipts[foreground].stopState < 3;
}
void RevokeMovement() {
    if (foreground < 0) return;
    Receipt& r = receipts[foreground];
    if (r.outcome < 3) r.outcome = 7;
    if (!r.stopState) r.stopState = 1;
}
void StopChecked(Receipt& r, const Sample& next) {
    void* controller = r.epoch == next.epoch && nativeState.worldEntered
        ? CheckedController(next.engine, next.viewportActor, next.pawn) : nullptr;
    if (!controller) {
        r.stopState = 4;
        if (r.action == StopAction && r.outcome < 3) r.outcome = 10;
        foreground = -1; return;
    }
    nativeStop(controller);
    r.stopState = 2;
    r.stopBegan = next.time;
    r.stableSince = 0;
    // A dispatched void call is not proof that movement stopped. Later native
    // samples, not the function's nonexistent return value, establish that.
}
void TickMovement(void* engine, const Sample& next) {
    if (InterlockedExchange(&manualPending, 0)) {
        EndOwner();
        if (foreground >= 0) {
            receipts[foreground].outcome = 9;
            receipts[foreground].stopState = 4;
            foreground = -1;
        }
    }
    if (foreground < 0) return;
    Receipt& r = receipts[foreground];
    r.observedSequence = next.sequence;
    if (r.epoch != next.epoch || !nativeState.worldEntered
        || !CheckedController(engine, next.viewportActor, next.pawn)) {
        r.outcome = 8; r.stopState = 4; foreground = -1;
        EndOwner();
        return;
    }
    if (r.stopState == 1) StopChecked(r, next);
    if (foreground < 0) return;
    DWORD now = next.time, elapsed = now - r.began;
    bool stable = Distance2(next.origin, r.last) <= 1 && Distance2(next.velocity, {0, 0, 0}) <= 1;
    if (!stable) r.stableSince = 0;
    else if (!r.stableSince) r.stableSince = now;
    r.last = next.origin;
    if (Distance2(r.origin, next.origin) > 4) r.progressed = true;
    bool quiet = r.stableSince && now - r.stableSince >= 600;
    if (r.stopState == 2) {
        if (quiet) {
            r.stopState = 3;
            if (r.action == StopAction && r.outcome < 3) r.outcome = 4;
            foreground = -1;
        } else if (now - r.stopBegan >= 5000) {
            r.stopState = 4;
            if (r.action == StopAction && r.outcome < 3) r.outcome = 10;
            foreground = -1;
        }
        return;
    }
    float dx = r.target.x - next.origin.x, dy = r.target.y - next.origin.y;
    if (quiet && dx * dx + dy * dy <= 16 * 16) {
        r.outcome = 3; foreground = -1;
    } else if (elapsed >= r.timeout) {
        r.outcome = 6; r.stopState = 1;
        StopChecked(r, next);
    } else if (elapsed >= 3000 && quiet) {
        // Lack of progress cannot distinguish collision, rejection or missing
        // publication. Do not invent a blocked/corrected classification.
        r.outcome = 5; r.stopState = 1;
        StopChecked(r, next);
    } else r.outcome = r.progressed ? 2 : 1;
}
void DispatchMovement(int index, const Sample& next) {
    Receipt& r = receipts[index];
    if (!CheckedController(next.engine, next.viewportActor, next.pawn)
        || (r.action == MoveAction && (foreground >= 0 || !LocalDestination(next.origin, r.target)))) {
        r.status = 4; return;
    }
    if (foreground >= 0) receipts[foreground].outcome = 7;
    foreground = lastMovement = index;
    r.origin = r.last = next.origin;
    r.began = next.time; r.observedSequence = next.sequence; r.outcome = 1;
    if (r.action == MoveAction) nativeMove(Handler(next.engine), next.pawn, r.target, next.origin, nullptr, 0);
    else { r.stopState = 1; StopChecked(r, next); }
    r.status = 1;
}

void __fastcall ManualMove(void* handler, void*, void* actor, Vector to, Vector from, void* target, int mode) {
    // Agent dispatch calls the verified export directly. Other calls through
    // this vtable slot are native movement intent, not passive position/server
    // callbacks. Revoke before forwarding; never stop the new manual movement.
    if (GetCurrentThreadId() != gameThread) InterlockedIncrement(&wrongThread);
    else if (!TryEnterCriticalSection(&sampleLock)) InterlockedExchange(&manualPending, 1);
    else {
        if (handler == Handler(currentEngine) && (*owner || foreground >= 0)) {
            EndOwner();
            if (foreground >= 0) {
                Receipt& r = receipts[foreground];
                r.outcome = 9;
                if (CheckedController(currentEngine, sample.viewportActor, sample.pawn)) {
                    nativeStop(sample.viewportActor);
                    r.stopState = 2;
                } else r.stopState = 4;
                // Subsequent motion belongs to the native caller. Do not use
                // its samples as stationary confirmation of our stop attempt.
                foreground = -1;
            }
        }
        LeaveCriticalSection(&sampleLock);
    }
    nativeMove(handler, actor, to, from, target, mode);
}
bool InstallMovement(HMODULE module) {
    nativeMove = reinterpret_cast<NativeMove>(GetProcAddress(module, "?MoveToLocation@UNetworkHandler@@UAEXPAVAActor@@VFVector@@10H@Z"));
    nativeStop = reinterpret_cast<NativeStop>(GetProcAddress(module, "?StopMove@ALineagePlayerController@@UAEXXZ"));
    playerControllerTable = reinterpret_cast<void**>(GetProcAddress(module, "??_7ALineagePlayerController@@6B@"));
    if (!nativeMove || !nativeStop || !Readable(playerControllerTable, 0x31c)
        || playerControllerTable[c4::ControllerStopSlot / 4] != reinterpret_cast<void*>(nativeStop)
        || networkTable[c4::NetworkMoveSlot / 4] != reinterpret_cast<void*>(nativeMove)) return false;
    DWORD protection = 0, ignored = 0;
    if (!VirtualProtect(networkTable + c4::NetworkMoveSlot / 4, sizeof(void*), PAGE_READWRITE, &protection)) return false;
    InterlockedExchangePointer(networkTable + c4::NetworkMoveSlot / 4, reinterpret_cast<void*>(&ManualMove));
    return VirtualProtect(networkTable + c4::NetworkMoveSlot / 4, sizeof(void*), protection, &ignored) != 0;
}
void RenderMovement(char* output, unsigned size) {
    if (lastMovement < 0) { strcpy(output, "null"); return; }
    const Receipt& r = receipts[lastMovement];
    char target[128];
    if (r.action == StopAction) strcpy(target, "null");
    else _snprintf(target, sizeof(target), "[%.6f,%.6f,%.6f]", r.target.x, r.target.y, r.target.z);
    _snprintf(output, size,
        "{\"source\":\"client_native\",\"requestId\":\"%s\",\"action\":\"%s\",\"epoch\":%lu,\"active\":%s,\"outcome\":\"%s\",\"stop\":\"%s\",\"observedSequence\":%lu,\"progressObserved\":%s,\"origin\":[%.6f,%.6f,%.6f],\"targetFloor\":%s,\"lastOrigin\":[%.6f,%.6f,%.6f],\"completionScope\":\"%s\",\"correctionClassification\":\"unavailable\"}",
        r.id, actions[r.action], r.epoch, foreground >= 0 ? "true" : "false", outcomes[r.outcome], stopStates[r.stopState],
        r.observedSequence, r.progressed ? "true" : "false", r.origin.x, r.origin.y, r.origin.z,
        target, r.last.x, r.last.y, r.last.z, r.action == StopAction ? "stationary_only" : "xy_and_stationary_only");
}
