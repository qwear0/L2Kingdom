#include <winsock2.h>
#include "profile.h"

namespace {
using Tick = void (__thiscall*)(void*, float);
using GetLevel = void* (__thiscall*)(void*);
using IsA = int (__thiscall*)(void*, void*);
using StaticClass = void* (__cdecl*)();
Tick originalTick;
GetLevel getLevel;
IsA isA;
void* actorClass;
StaticClass actorStaticClass;
CRITICAL_SECTION sampleLock;
volatile LONG started;
DWORD lastSampleTime;
struct Sample {
    DWORD sequence, time, thread, epoch;
    void* engine;
    void* viewportActor;
    void* level;
};
Sample sample;

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

// The exported UObject-side vtable owns a thiscall Tick(float) slot at +0x64
// in the SHA-pinned build. A fastcall shim consumes its ECX and stack argument
// without copying instructions or changing the original tick's ordering.
void __fastcall OnTick(void* engine, void*, float delta) {
    originalTick(engine, delta);
    DWORD now = GetTickCount();
    if (now - lastSampleTime < 200) return;
    lastSampleTime = now;
    Sample next = {};
    next.time = now;
    next.thread = GetCurrentThreadId();
    next.engine = engine;
    if (!actorClass) actorClass = actorStaticClass();
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
        }
    }
    // RPC serialization must never stall the game thread. A contended sample
    // is skipped, not waited for; world pointers are opaque diagnostic IDs.
    if (!TryEnterCriticalSection(&sampleLock)) return;
    next.sequence = sample.sequence + 1;
    next.epoch = sample.epoch + (next.engine != sample.engine || next.level != sample.level || next.viewportActor != sample.viewportActor);
    sample = next;
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
    if (!table || !tick || !getLevel || !isA || !actorStaticClass || !Readable(table, 0x68) || table[0x64 / 4] != reinterpret_cast<void*>(tick)) return false;
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
    char request[128];
    unsigned used = 0;
    DWORD began = GetTickCount();
    while (used < sizeof(request) - 1) {
        if (GetTickCount() - began >= 1000) return;
        int n = recv(socket, request + used, 1, 0);
        if (n != 1) return;
        if (request[used++] == '\n') break;
    }
    if (!used || request[used - 1] != '\n') return;
    request[used - 1] = 0;
    // Per-launch token grants only these read-only P0 observations. No auth,
    // movement, memory access, engine calls or process control exist over RPC.
    if (strlen(request) < 65 || memcmp(request, token, 64) || request[64] != ' ') return;
    const char* command = request + 65;
    if (strcmp(command, "health") && strcmp(command, "sample")) {
        SendAll(socket, "{\"error\":\"unsupported_p0_command\"}\n");
        return;
    }
    EnterCriticalSection(&sampleLock);
    Sample copy = sample;
    LeaveCriticalSection(&sampleLock);
    char response[1024], age[16];
    if (copy.sequence) _snprintf(age, sizeof(age), "%lu", GetTickCount() - copy.time);
    else strcpy(age, "null");
    _snprintf(response, sizeof(response),
        "{\"protocol\":\"c4-agent-p0/1\",\"profile\":\"%s\",\"pid\":%lu,\"sequence\":%lu,\"ageMs\":%s,\"tickThread\":%lu,\"epoch\":%lu,\"engine\":\"%p\",\"viewportActor\":\"%p\",\"level\":\"%p\",\"pawn\":null,\"capabilities\":[\"health\",\"native_tick_sample\"],\"collision\":\"unverified\",\"gameLogin\":\"unverified\"}\n",
        c4::Profile, GetCurrentProcessId(), copy.sequence, age,
        copy.thread, copy.epoch, copy.engine, copy.viewportActor, copy.level);
    SendAll(socket, response);
}

DWORD Fail(DWORD stage) {
    fprintf(stderr, "C4 P0: DLL setup failed at stage %lu (Windows error %lu).\n", stage, GetLastError());
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
        "{\"protocol\":\"c4-agent-p0/1\",\"profile\":\"%s\",\"pid\":%lu,\"host\":\"127.0.0.1\",\"port\":%u,\"token\":\"%s\"}\n",
        c4::Profile, GetCurrentProcessId(), ntohs(address.sin_port), token);
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
