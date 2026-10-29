#include <winsock2.h>
#include "profile.h"

namespace {
using Tick = void (__thiscall*)(void*, float);
using GetLevel = void* (__thiscall*)(void*);
using IsA = int (__thiscall*)(void*, void*);
using StaticClass = void* (__cdecl*)();
struct Vector { float x, y, z; };
struct CheckResult {
    void* next;
    void* actor;
    Vector location, normal;
    void* primitive;
    float time;
    int item;
    void* material;
};
static_assert(sizeof(CheckResult) == 0x30, "Exact-build FCheckResult ABI");
using LineCheck = int (__thiscall*)(void*, CheckResult&, void*, const Vector&, const Vector&, DWORD, Vector);
Tick originalTick;
GetLevel getLevel;
LineCheck lineCheck;
IsA isA;
void* actorClass;
void* pawnClass;
void* controllerClass;
StaticClass actorStaticClass, pawnStaticClass, controllerStaticClass;
CRITICAL_SECTION sampleLock;
volatile LONG started;
DWORD lastSampleTime;
struct Sample {
    DWORD sequence, time, thread, epoch;
    void* engine;
    void* viewportActor;
    void* level;
    void* pawn;
    Vector origin;
    float radius, height;
};
Sample sample;
struct Surface {
    DWORD id, epoch;
    int status; // 0 unavailable, 1 queued, 2 hit, 3 clear, 4 stale, 5 invalid native result
    int nativeReturn;
    Vector start, end;
    CheckResult hit;
};
Surface surface;
void* requestedPawn;
constexpr DWORD WorldTraceMask = 0x86;

bool Finite(float value) { return value == value && value > -10000000.0f && value < 10000000.0f; }
bool Finite(Vector value) { return Finite(value.x) && Finite(value.y) && Finite(value.z); }

bool Readable(const void* address, SIZE_T size) {
    MEMORY_BASIC_INFORMATION memory;
    if (!address || !VirtualQuery(address, &memory, sizeof(memory))) return false;
    DWORD access = memory.Protect & 0xff;
    return memory.State == MEM_COMMIT && !(memory.Protect & PAGE_GUARD)
        && access != PAGE_NOACCESS && access != PAGE_EXECUTE
        && reinterpret_cast<ULONG_PTR>(address) >= reinterpret_cast<ULONG_PTR>(memory.BaseAddress)
        && reinterpret_cast<ULONG_PTR>(address) + size >= reinterpret_cast<ULONG_PTR>(address)
        && reinterpret_cast<ULONG_PTR>(address) + size <= reinterpret_cast<ULONG_PTR>(memory.BaseAddress) + memory.RegionSize;
}

void* PointerAt(void* object, SIZE_T offset) {
    if (!object) return nullptr;
    BYTE* address = static_cast<BYTE*>(object) + offset;
    return Readable(address, sizeof(void*)) ? *reinterpret_cast<void**>(address) : nullptr;
}

#include "session.h"

// The exported UObject-side vtable owns a thiscall Tick(float) slot at +0x64
// in the SHA-pinned build. A fastcall shim consumes its ECX and stack argument
// without copying instructions or changing the original tick's ordering.
void __fastcall OnTick(void* engine, void*, float delta) {
    bool correctThread = session::BeginTick(engine);
    originalTick(engine, delta);
    if (!correctThread) return;
    DWORD now = GetTickCount();
    if (now - lastSampleTime < 200) return;
    lastSampleTime = now;
    Sample next = {};
    next.time = now;
    next.thread = GetCurrentThreadId();
    next.engine = engine;
    if (!actorClass) actorClass = actorStaticClass();
    if (!pawnClass) pawnClass = pawnStaticClass();
    if (!controllerClass) controllerClass = controllerStaticClass();
    // These offsets come from this build's UGameEngine::Tick viewport path,
    // not a different C4 SDK. No object pointer leaves this frame for reading.
    void* client = PointerAt(engine, 0x58);
    void* viewports = PointerAt(client, 0x38);
    void* countAddress = client ? static_cast<BYTE*>(client) + 0x3c : nullptr;
    if (client && Readable(countAddress, sizeof(int)) && *static_cast<int*>(countAddress) > 0) {
        void* viewport = PointerAt(viewports, 0);
        void* actor = PointerAt(viewport, 0x3c);
        if (actorClass && Readable(actor, 0x100) && isA(actor, actorClass)) {
            next.viewportActor = actor;
            next.level = getLevel(actor);
            // execTrace in this build resolves a controller's source through
            // +0x3a8. Location and cylinder fields are from execFastTrace and
            // GetCylinderExtent, respectively, not a borrowed SDK layout.
            void* pawn = isA(actor, pawnClass) ? actor
                : (isA(actor, controllerClass) ? PointerAt(actor, 0x3a8) : nullptr);
            if (Readable(pawn, 0x2f8) && isA(pawn, pawnClass) && getLevel(pawn) == next.level) {
                next.origin = *reinterpret_cast<Vector*>(static_cast<BYTE*>(pawn) + 0x1bc);
                next.radius = *reinterpret_cast<float*>(static_cast<BYTE*>(pawn) + 0x2f0);
                next.height = *reinterpret_cast<float*>(static_cast<BYTE*>(pawn) + 0x2f4);
                if (Finite(next.origin) && next.radius > 0 && next.radius < 512 && next.height > 0 && next.height < 512) next.pawn = pawn;
            }
        }
    }
    // RPC serialization must never stall the game thread. A contended sample
    // is skipped, not waited for; world pointers are opaque diagnostic IDs.
    if (!TryEnterCriticalSection(&sampleLock)) return;
    next.sequence = sample.sequence + 1;
    next.epoch = sample.epoch + (next.engine != sample.engine || next.level != sample.level || next.viewportActor != sample.viewportActor || next.pawn != sample.pawn);
    sample = next;
    session::Tick(engine, next.epoch, next.pawn != nullptr);
    if (surface.status == 1) {
        if (!next.pawn || surface.epoch != next.epoch || requestedPawn != next.pawn) surface.status = 4;
        else {
            surface.start = next.origin;
            surface.end = {next.origin.x, next.origin.y, next.origin.z - next.height - 256.0f};
            surface.hit = {};
            surface.hit.time = 1.0f;
            surface.hit.item = -1;
            // Match this binary's execTrace(false) mask, endpoint order and
            // zero extent. FCheckResult's 12 dwords and output offsets are
            // verified in execTrace/SingleLineCheck. This is one loaded-world
            // ray, not a swept cylinder or a claim of complete map loading.
            surface.nativeReturn = lineCheck(next.level, surface.hit, next.pawn, surface.end, surface.start, WorldTraceMask, {0, 0, 0});
            surface.status = surface.nativeReturn == 1 ? 3 : 2;
            if ((surface.nativeReturn != 0 && surface.nativeReturn != 1)
                || (surface.status == 2 && (!surface.hit.actor || !Finite(surface.hit.location) || !Finite(surface.hit.normal)
                    || !(surface.hit.time >= 0 && surface.hit.time <= 1)))) surface.status = 5;
            // Native linked results can use frame scratch storage. Expose only
            // copied values/opaque IDs; never retain a linked-list reference.
            surface.hit.next = nullptr;
        }
    }
    LeaveCriticalSection(&sampleLock);
}

bool InstallTick() {
    HMODULE engine = GetModuleHandleA("Engine.dll");
    HMODULE core = GetModuleHandleA("Core.dll");
    auto table = reinterpret_cast<void**>(GetProcAddress(engine, "??_7UGameEngine@@6BUObject@@@"));
    auto tick = GetProcAddress(engine, "?Tick@UGameEngine@@UAEXM@Z");
    getLevel = reinterpret_cast<GetLevel>(GetProcAddress(engine, "?GetLevel@AActor@@QBEPAVULevel@@XZ"));
    isA = reinterpret_cast<IsA>(GetProcAddress(core, "?IsA@UObject@@QBEHPAVUClass@@@Z"));
    actorStaticClass = reinterpret_cast<StaticClass>(GetProcAddress(engine, "?StaticClass@AActor@@SAPAVUClass@@XZ"));
    pawnStaticClass = reinterpret_cast<StaticClass>(GetProcAddress(engine, "?StaticClass@APawn@@SAPAVUClass@@XZ"));
    controllerStaticClass = reinterpret_cast<StaticClass>(GetProcAddress(engine, "?StaticClass@AController@@SAPAVUClass@@XZ"));
    lineCheck = reinterpret_cast<LineCheck>(GetProcAddress(engine, "?SingleLineCheck@ULevel@@UAEHAAUFCheckResult@@PAVAActor@@ABVFVector@@2KV4@@Z"));
    if (!table || !tick || !getLevel || !isA || !actorStaticClass || !pawnStaticClass || !controllerStaticClass || !lineCheck
        || !Readable(table, 0x68) || table[0x64 / 4] != reinterpret_cast<void*>(tick)) return false;
    if (!session::Install(engine)) return false;
    originalTick = reinterpret_cast<Tick>(tick);
    DWORD protection = 0;
    if (!VirtualProtect(table + 0x64 / 4, sizeof(void*), PAGE_READWRITE, &protection)) return false;
    InterlockedExchangePointer(table + 0x64 / 4, reinterpret_cast<void*>(&OnTick));
    DWORD ignored = 0;
    if (!VirtualProtect(table + 0x64 / 4, sizeof(void*), protection, &ignored)) return false;
    return true;
}

bool SendAll(SOCKET socket, const char* data) {
    int remaining = static_cast<int>(strlen(data));
    while (remaining) {
        int sent = send(socket, data, remaining, 0);
        if (sent <= 0) return false;
        data += sent;
        remaining -= sent;
    }
    return true;
}

void Serve(SOCKET socket, const char* token) {
    DWORD timeout = 1000;
    setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout));
    setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout));
    struct PrivateRequest {
        char bytes[512] = {};
        ~PrivateRequest() { SecureZeroMemory(bytes, sizeof(bytes)); }
    } privateRequest;
    char* request = privateRequest.bytes;
    unsigned used = 0;
    DWORD began = GetTickCount();
    while (used < sizeof(privateRequest.bytes) - 1) {
        if (GetTickCount() - began >= 1000) return;
        int n = recv(socket, request + used, 1, 0);
        if (n != 1) return;
        if (request[used++] == '\n') break;
    }
    if (!used || request[used - 1] != '\n') return;
    request[used - 1] = 0;
    // The worker parses/copies fixed requests only. Native login and geometry
    // execute on the checked game tick, never on this socket thread.
    if (strlen(request) < 65 || memcmp(request, token, 64) || request[64] != ' ') return;
    const char* command = request + 65;
    if (!strcmp(command, "surface")) {
        EnterCriticalSection(&sampleLock);
        const char* error = surface.status == 1 ? "surface_busy" : (!sample.pawn ? "pawn_unavailable" : nullptr);
        if (!error) {
            surface.id += 1;
            surface.epoch = sample.epoch;
            surface.status = 1;
            requestedPawn = sample.pawn;
        }
        DWORD id = surface.id, epoch = surface.epoch;
        LeaveCriticalSection(&sampleLock);
        char reply[128];
        if (error) _snprintf(reply, sizeof(reply), "{\"error\":\"%s\"}\n", error);
        else _snprintf(reply, sizeof(reply), "{\"requestId\":%lu,\"epoch\":%lu,\"status\":\"queued\"}\n", id, epoch);
        SendAll(socket, reply);
        return;
    }
    if (strcmp(command, "health") && strcmp(command, "sample")) {
        char reply[1024];
        EnterCriticalSection(&sampleLock);
        session::Rpc(command, sample.epoch, sample.sequence && GetTickCount() - sample.time < 5000, reply, sizeof(reply));
        LeaveCriticalSection(&sampleLock);
        SendAll(socket, reply);
        SendAll(socket, "\n");
        return;
    }
    EnterCriticalSection(&sampleLock);
    Sample copy = sample;
    Surface ray = surface;
    char sessionJson[768];
    session::ExpireOwner();
    session::Render(sessionJson, sizeof(sessionJson));
    LeaveCriticalSection(&sampleLock);
    // Serve runs serially on the sole RPC worker; keep the large public JSON
    // buffer off its stack without introducing a CRT stack-probe dependency.
    static char response[4096];
    char age[16], pawn[256], result[512];
    if (copy.sequence) _snprintf(age, sizeof(age), "%lu", GetTickCount() - copy.time);
    else strcpy(age, "null");
    if (copy.pawn) _snprintf(pawn, sizeof(pawn),
        "{\"id\":\"%p\",\"origin\":[%.6f,%.6f,%.6f],\"radius\":%.6f,\"height\":%.6f}",
        copy.pawn, copy.origin.x, copy.origin.y, copy.origin.z, copy.radius, copy.height);
    else strcpy(pawn, "null");
    const char* statuses[] = {"unavailable", "queued", "hit", "clear", "stale_epoch", "invalid_native_result"};
    if (ray.status == 2) _snprintf(result, sizeof(result),
        "{\"actor\":\"%p\",\"location\":[%.6f,%.6f,%.6f],\"normal\":[%.6f,%.6f,%.6f],\"time\":%.6f,\"item\":%d,\"primitive\":\"%p\",\"material\":\"%p\"}",
        ray.hit.actor, ray.hit.location.x, ray.hit.location.y, ray.hit.location.z,
        ray.hit.normal.x, ray.hit.normal.y, ray.hit.normal.z, ray.hit.time, ray.hit.item, ray.hit.primitive, ray.hit.material);
    else strcpy(result, "null");
    _snprintf(response, sizeof(response),
        "{\"protocol\":\"c4-agent/1\",\"profile\":\"%s\",\"pid\":%lu,\"sequence\":%lu,\"ageMs\":%s,\"tickThread\":%lu,\"epoch\":%lu,\"engine\":\"%p\",\"viewportActor\":\"%p\",\"level\":\"%p\",\"pawn\":%s,\"session\":%s,\"capabilities\":[\"health\",\"native_tick_sample\",\"surface\",\"session_observe\",\"native_login\"],\"surface\":{\"requestId\":%lu,\"epoch\":%lu,\"status\":\"%s\",\"nativeReturn\":%d,\"mask\":%lu,\"extent\":[0,0,0],\"start\":[%.6f,%.6f,%.6f],\"end\":[%.6f,%.6f,%.6f],\"hit\":%s}}\n",
        c4::Profile, GetCurrentProcessId(), copy.sequence, age, copy.thread, copy.epoch, copy.engine, copy.viewportActor, copy.level, pawn, sessionJson,
        ray.id, ray.epoch, statuses[ray.status], ray.nativeReturn, WorldTraceMask,
        ray.start.x, ray.start.y, ray.start.z, ray.end.x, ray.end.y, ray.end.z, result);
    SendAll(socket, response);
}

DWORD Fail(DWORD stage) {
    fprintf(stderr, "C4 agent: DLL setup failed at stage %lu (Windows error %lu).\n", stage, GetLastError());
    fflush(stderr);
    return stage;
}

DWORD WINAPI Worker(void*) {
    char token[65], session[MAX_PATH];
    DWORD sessionLength = GetEnvironmentVariableA("C4_AGENT_SESSION", session, sizeof(session));
    if (GetEnvironmentVariableA("C4_AGENT_TOKEN", token, sizeof(token)) != 64
        || !sessionLength || sessionLength >= sizeof(session) || !c4::VerifyBuild(true)) return Fail(1);
    SetEnvironmentVariableA("C4_AGENT_TOKEN", nullptr);
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data)) return Fail(2);
    SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) return Fail(3);
    sockaddr_in address = {};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) || listen(listener, 4)) {
        closesocket(listener); return Fail(4);
    }
    int addressSize = sizeof(address);
    if (getsockname(listener, reinterpret_cast<sockaddr*>(&address), &addressSize)) { closesocket(listener); return Fail(5); }
    InitializeCriticalSection(&sampleLock);
    if (!InstallTick()) { closesocket(listener); return Fail(6); }
    char descriptor[512];
    int length = _snprintf(descriptor, sizeof(descriptor),
        "{\"protocol\":\"%s\",\"profile\":\"%s\",\"pid\":%lu,\"host\":\"127.0.0.1\",\"port\":%u,\"token\":\"%s\"}\n",
        c4::Protocol, c4::Profile, GetCurrentProcessId(), ntohs(address.sin_port), token);
    // The host creates this file with mode 0600 before launch. Do not create a
    // token-bearing file with Wine's inherited/default Unix permissions.
    HANDLE file = CreateFileA(session, GENERIC_WRITE, 0, nullptr, TRUNCATE_EXISTING, 0, nullptr);
    DWORD written = 0;
    bool saved = file != INVALID_HANDLE_VALUE && length > 0 && length < static_cast<int>(sizeof(descriptor))
        && WriteFile(file, descriptor, length, &written, nullptr) && written == static_cast<DWORD>(length);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    if (!saved) { closesocket(listener); return Fail(7); }
    char name[80];
    c4::ReadyEventName(name, sizeof(name), GetCurrentProcessId());
    HANDLE ready = OpenEventA(EVENT_MODIFY_STATE, FALSE, name);
    if (!ready || !SetEvent(ready)) { if (ready) CloseHandle(ready); closesocket(listener); return Fail(8); }
    CloseHandle(ready);
    while (true) {
        SOCKET connection = accept(listener, nullptr, nullptr);
        if (connection == INVALID_SOCKET) break;
        Serve(connection, token);
        closesocket(connection);
    }
    closesocket(listener);
    WSACleanup();
    return 0;
}
}

extern "C" __declspec(dllexport) DWORD WINAPI C4AgentStart(void*) {
    if (InterlockedCompareExchange(&started, 1, 0)) return 0;
    HANDLE thread = CreateThread(nullptr, 0, Worker, nullptr, 0, nullptr);
    if (!thread) return 0;
    CloseHandle(thread);
    return 1;
}

extern "C" BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, void*) {
    if (reason == DLL_PROCESS_ATTACH) DisableThreadLibraryCalls(module);
    return TRUE;
}
