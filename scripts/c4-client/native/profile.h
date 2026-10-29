#pragma once
#include <windows.h>
#include <wincrypt.h>
#include <stdio.h>
#include <string.h>

static_assert(sizeof(void*) == 4, "The C4 profile requires an x86 build");

namespace c4 {
constexpr const char* Profile = "l2solo-c4-656-0293b3ed-p1";
constexpr const char* Protocol = "c4-agent/4";
// UNetworkHandler::Init writes this module-relative singleton. Its notify
// subobject must match UGameEngine +0x38 (verified in this build's constructor).
constexpr SIZE_T NetworkSingleton = 0x6d5e68;
constexpr SIZE_T EngineNotify = 0x38;
constexpr SIZE_T NetworkNotify = 0x54;
constexpr SIZE_T NetworkAuthDriver = 0x4c;
constexpr SIZE_T NetworkGameDriver = 0x48;
constexpr SIZE_T NetworkAuthPending = 0x50;
constexpr SIZE_T DriverTransport = 0x38;
constexpr SIZE_T EngineConsole = 0x6c;
// setPhysics, physWalking and native controller movement/stop disassembly pin
// these fields/slots. Raw origin and floor contact are deliberately not equated.
constexpr SIZE_T ActorPhysics = 0x34, ActorYaw = 0x1cc, ActorVelocity = 0x1d4;
constexpr SIZE_T PawnController = 0x13f0, ControllerPawn = 0x3a8;
constexpr SIZE_T ControllerStopSlot = 0x318, NetworkMoveSlot = 0xdc;
// SHA-pinned NWindow console class and its native Start(index) wrapper. The
// wrapper calls RequestGameStart, then performs the matching UI transition.
constexpr SIZE_T WindowConsoleTable = 0x1b2428;
constexpr SIZE_T WindowGameStart = 0x65120;
// RequestAuthLogin accesses auth-driver fields through +0x4f68. Merely
// finding the network singleton does not prove driver initialization finished.
constexpr SIZE_T AuthDriverFields = 0x4f6c;
struct Identity { const char* name; const char* sha256; };
constexpr Identity Identities[] = {
    {"L2.exe", "11814d7246de9ce13e0a3ffd5a3679540a21386ca2d15e65234917f9bbef0710"},
    {"Engine.dll", "0293b3ed11c1a107eb2e665b7368531468f1485f98699701e94166cfad123832"},
    {"Core.dll", "b3b367b7b8fea00641d789b8d7acfb9e520ef9f88bd46ea834736e0017c4643f"},
    {"NWindow.dll", "860765f28ee5687b0cde8852ddddd21c615b26983a3a6a74b021586f1185ac72"}
};

inline bool HashMatches(const char* path, const char* expected) {
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    HANDLE file = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    bool ok = CryptAcquireContextA(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)
        && CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash);
    BYTE buffer[1024];
    DWORD count = 0;
    while (ok) {
        if (!ReadFile(file, buffer, sizeof(buffer), &count, nullptr)) { ok = false; break; }
        if (!count) break;
        ok = CryptHashData(hash, buffer, count, 0);
    }
    BYTE digest[32];
    DWORD length = sizeof(digest);
    if (ok) ok = CryptGetHashParam(hash, HP_HASHVAL, digest, &length, 0) && length == sizeof(digest);
    if (ok) {
        const char* hex = "0123456789abcdef";
        for (unsigned i = 0; i < sizeof(digest); ++i) {
            if (expected[i * 2] != hex[digest[i] >> 4] || expected[i * 2 + 1] != hex[digest[i] & 15]) ok = false;
        }
    }
    if (hash) CryptDestroyHash(hash);
    if (provider) CryptReleaseContext(provider, 0);
    CloseHandle(file);
    return ok;
}

inline bool VerifyBuild(bool loaded) {
    for (const auto& identity : Identities) {
        char path[MAX_PATH];
        if (loaded) {
            HMODULE module = GetModuleHandleA(identity.name);
            // NWindow is loaded later, not a static L2 import. Pin its disk
            // identity now; session::ResolveWindow checks its loaded path again
            // before the game thread may use the exact console wrapper.
            if (!module && strcmp(identity.name, "NWindow.dll")) return false;
            DWORD n = module ? GetModuleFileNameA(module, path, sizeof(path))
                : GetFullPathNameA(identity.name, sizeof(path), path, nullptr);
            if (!n || n >= sizeof(path)) return false;
        } else {
            DWORD n = GetFullPathNameA(identity.name, sizeof(path), path, nullptr);
            if (!n || n >= sizeof(path)) return false;
        }
        if (!HashMatches(path, identity.sha256)) return false;
    }
    return true;
}

inline void ReadyEventName(char* name, unsigned size, DWORD pid) {
    _snprintf(name, size, "Local\\C4Agent-P1-%lu", pid);
}
}
