#pragma once

// Included after the checked memory helpers in agent.cpp. Native callbacks
// only copy game-thread observations; the RPC worker reads published copies.
namespace session {
using Login = int (__thiscall*)(void*, wchar_t*, wchar_t*);
using NoArgs = int (__thiscall*)(void*);
using OneInt = int (__thiscall*)(void*, int);
using StackArg = int (__thiscall*)(void*, void*);
using AddServer = int (__thiscall*)(void*, int, wchar_t*, int, int, int, int);
Login login;
NoArgs authSuccess, serverSuccess;
OneInt authFailure, serverFailure, listStart, listEnd;
StackArg listAddStack;
AddServer listAdd;
void** networkTable;
void** notifyTable;
HMODULE engineModule;
DWORD gameThread;
void* currentEngine;
volatile LONG wrongThread;
struct State {
    int phase, failure;
    DWORD revision, listEntries;
    bool handlerValid, authTransport, gameTransport, loginReady;
};
State nativeState, published;
const char* phases[] = {"no_auth_observed", "auth_accepted_consent_unverified", "auth_rejected",
    "server_list_receiving", "server_list_ready", "game_handoff", "server_rejected"};

bool Callback(void* self) {
    if (GetCurrentThreadId() != gameThread) { InterlockedIncrement(&wrongThread); return false; }
    return currentEngine && self == static_cast<BYTE*>(currentEngine) + c4::EngineNotify;
}
void Phase(int value, int failure = 0) {
    nativeState.phase = value;
    nativeState.failure = failure;
    ++nativeState.revision;
}
int __fastcall AuthSuccess(void* self, void*) {
    if (Callback(self)) Phase(1);
    return authSuccess(self);
}
int __fastcall AuthFailure(void* self, void*, int code) {
    if (Callback(self)) Phase(2, code);
    return authFailure(self, code);
}
int __fastcall ServerSuccess(void* self, void*) {
    if (Callback(self)) Phase(5);
    return serverSuccess(self);
}
int __fastcall ServerFailure(void* self, void*, int code) {
    if (Callback(self)) Phase(6, code);
    return serverFailure(self, code);
}
int __fastcall ListStart(void* self, void*, int count) {
    if (Callback(self)) { nativeState.listEntries = 0; Phase(3); }
    return listStart(self, count);
}
int __fastcall ListEnd(void* self, void*, int value) {
    if (Callback(self)) Phase(4);
    return listEnd(self, value);
}
int __fastcall ListAddStack(void* self, void*, void* stack) {
    if (Callback(self)) ++nativeState.listEntries;
    return listAddStack(self, stack);
}
int __fastcall ListAdd(void* self, void*, int id, wchar_t* name, int a, int b, int c, int d) {
    if (Callback(self)) ++nativeState.listEntries;
    return listAdd(self, id, name, a, b, c, d);
}

bool Install(HMODULE module) {
    engineModule = module;
    networkTable = reinterpret_cast<void**>(GetProcAddress(module, "??_7UNetworkHandler@@6BUObject@@@"));
    notifyTable = reinterpret_cast<void**>(GetProcAddress(module, "??_7UGameEngine@@6B@"));
    login = reinterpret_cast<Login>(GetProcAddress(module, "?RequestAuthLogin@UNetworkHandler@@UAEHPAG0@Z"));
    struct Hook { unsigned offset; const char* symbol; void* replacement; void** original; };
    Hook hooks[] = {
        {0x70, "?OnAuthLoginSuccess@UGameEngine@@UAEHXZ", reinterpret_cast<void*>(&AuthSuccess), reinterpret_cast<void**>(&authSuccess)},
        {0x74, "?OnStartServerList@UGameEngine@@UAEHH@Z", reinterpret_cast<void*>(&ListStart), reinterpret_cast<void**>(&listStart)},
        {0x78, "?OnAddServerList@UGameEngine@@UAEHAAVL2ParamStack@@@Z", reinterpret_cast<void*>(&ListAddStack), reinterpret_cast<void**>(&listAddStack)},
        {0x7c, "?OnAddServerList@UGameEngine@@UAEHHPAGHHHH@Z", reinterpret_cast<void*>(&ListAdd), reinterpret_cast<void**>(&listAdd)},
        {0x80, "?OnEndServerList@UGameEngine@@UAEHH@Z", reinterpret_cast<void*>(&ListEnd), reinterpret_cast<void**>(&listEnd)},
        {0x84, "?OnAuthLoginFail@UGameEngine@@UAEHH@Z", reinterpret_cast<void*>(&AuthFailure), reinterpret_cast<void**>(&authFailure)},
        {0x94, "?OnAuthServerSelectSuccess@UGameEngine@@UAEHXZ", reinterpret_cast<void*>(&ServerSuccess), reinterpret_cast<void**>(&serverSuccess)},
        {0x98, "?OnAuthServerSelectFail@UGameEngine@@UAEHH@Z", reinterpret_cast<void*>(&ServerFailure), reinterpret_cast<void**>(&serverFailure)}
    };
    if (!login || !networkTable || !Readable(notifyTable, 0x9c)) return false;
    for (auto& hook : hooks) {
        auto address = reinterpret_cast<void*>(GetProcAddress(module, hook.symbol));
        if (!address || notifyTable[hook.offset / 4] != address) return false;
        *hook.original = address;
    }
    DWORD protection = 0;
    if (!VirtualProtect(notifyTable, 0x9c, PAGE_READWRITE, &protection)) return false;
    for (auto& hook : hooks) InterlockedExchangePointer(notifyTable + hook.offset / 4, hook.replacement);
    DWORD ignored = 0;
    return VirtualProtect(notifyTable, 0x9c, protection, &ignored) != 0;
}

bool BeginTick(void* engine) {
    if (!gameThread) gameThread = GetCurrentThreadId();
    if (gameThread != GetCurrentThreadId()) { InterlockedIncrement(&wrongThread); return false; }
    currentEngine = engine;
    return true;
}
void* Handler(void* engine) {
    void* handler = PointerAt(engineModule, c4::NetworkSingleton);
    void* notify = static_cast<BYTE*>(engine) + c4::EngineNotify;
    if (wrongThread || !Readable(handler, 0x58) || PointerAt(handler, 0) != networkTable
        || PointerAt(handler, c4::NetworkNotify) != notify || PointerAt(notify, 0) != notifyTable) return nullptr;
    return handler;
}

constexpr unsigned ReceiptLimit = 32;
constexpr DWORD OwnerTTL = 15000;
struct Receipt {
    char id[33];
    BYTE digest[32];
    DWORD epoch;
    int status, nativeReturn;
};
Receipt receipts[ReceiptLimit];
unsigned receiptCount;
int queued = -1;
bool loginDispatched;
DWORD queuedAt, ownerTime;
char owner[33];
wchar_t account[15], password[17];
const char* statuses[] = {"queued", "dispatched", "stale_epoch", "owner_lost", "native_unavailable", "native_rejected", "queue_expired"};

void ClearCredentials() {
    SecureZeroMemory(account, sizeof(account));
    SecureZeroMemory(password, sizeof(password));
}
void EndOwner() {
    if (queued >= 0) { receipts[queued].status = 3; queued = -1; }
    ClearCredentials();
    SecureZeroMemory(owner, sizeof(owner));
}
void ExpireOwner() { if (*owner && GetTickCount() - ownerTime >= OwnerTTL) EndOwner(); }
void Tick(void* engine, DWORD epoch, bool pawn) {
    void* handler = Handler(engine);
    nativeState.handlerValid = handler != nullptr;
    void* auth = PointerAt(handler, c4::NetworkAuthDriver);
    void* game = PointerAt(handler, c4::NetworkGameDriver);
    nativeState.authTransport = PointerAt(auth, c4::DriverTransport) != nullptr;
    nativeState.gameTransport = PointerAt(game, c4::DriverTransport) != nullptr;
    nativeState.loginReady = handler && !pawn && !loginDispatched && !nativeState.authTransport && !nativeState.gameTransport
        && Readable(auth, c4::AuthDriverFields) && Readable(game, c4::DriverTransport + sizeof(void*))
        && !*reinterpret_cast<int*>(static_cast<BYTE*>(handler) + c4::NetworkAuthPending)
        && Readable(PointerAt(engine, c4::EngineConsole), sizeof(void*)) && nativeState.phase == 0;
    published = nativeState;
    ExpireOwner();
    if (queued < 0) return;
    Receipt& receipt = receipts[queued];
    if (GetTickCount() - queuedAt >= 10000) receipt.status = 6;
    else if (receipt.epoch != epoch) receipt.status = 2;
    else if (!nativeState.loginReady) receipt.status = 4;
    else {
        // Native return 1 means only that the client's login path was invoked.
        // Auth callbacks and a later checked pawn are separate observations.
        loginDispatched = true;
        receipt.nativeReturn = login(handler, account, password);
        receipt.status = receipt.nativeReturn == 1 ? 1 : 5;
        published.loginReady = false;
    }
    queued = -1;
    ClearCredentials();
}

bool Hex(const char* value, unsigned size) {
    if (strlen(value) != size) return false;
    for (unsigned i = 0; i < size; ++i) if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
    return true;
}
unsigned Nibble(char c) { return c <= '9' ? c - '0' : c - 'a' + 10; }
bool Decode(const char* hex, wchar_t* output, unsigned capacity) {
    unsigned size = static_cast<unsigned>(strlen(hex));
    if (!size || size % 4 || size / 4 >= capacity || !Hex(hex, size)) return false;
    for (unsigned i = 0; i < size / 4; ++i) {
        unsigned value = Nibble(hex[i * 4]) * 16 + Nibble(hex[i * 4 + 1]);
        if (value < 0x21 || value > 0x7e || hex[i * 4 + 2] != '0' || hex[i * 4 + 3] != '0') return false;
        output[i] = static_cast<wchar_t>(value);
    }
    output[size / 4] = 0;
    return true;
}
bool Digest(const char* value, BYTE* output) {
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    DWORD size = 32;
    bool ok = CryptAcquireContextA(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)
        && CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)
        && CryptHashData(hash, reinterpret_cast<const BYTE*>(value), static_cast<DWORD>(strlen(value)), 0)
        && CryptGetHashParam(hash, HP_HASHVAL, output, &size, 0) && size == 32;
    if (hash) CryptDestroyHash(hash);
    if (provider) CryptReleaseContext(provider, 0);
    return ok;
}
void Render(char* output, unsigned size) {
    _snprintf(output, size,
        "{\"source\":\"client_network\",\"state\":\"%s\",\"revision\":%lu,\"nativeFailureCode\":%d,\"handlerValid\":%s,\"authTransportPresent\":%s,\"gameTransportPresent\":%s,\"serverListCallbacks\":%lu,\"loginReady\":%s,\"ownerActive\":%s,\"wrongThreadCallbacks\":%ld,\"consent\":\"unverified_no_automatic_acceptance\"}",
        phases[published.phase], published.revision, published.failure, published.handlerValid ? "true" : "false",
        published.authTransport ? "true" : "false", published.gameTransport ? "true" : "false", published.listEntries,
        published.loginReady && queued < 0 ? "true" : "false", *owner ? "true" : "false", wrongThread);
}
void RenderReceipt(const Receipt& receipt, char* output, unsigned size) {
    _snprintf(output, size, "{\"requestId\":\"%s\",\"epoch\":%lu,\"status\":\"%s\",\"nativeReturn\":%d}",
        receipt.id, receipt.epoch, statuses[receipt.status], receipt.nativeReturn);
}

// Called with sampleLock held. Parsing/digests/disk-free transport stay on the
// RPC worker; the game thread consumes only the fixed-size credential mailbox.
void Rpc(const char* command, DWORD epoch, bool fresh, char* output, unsigned size) {
    ExpireOwner();
    strcpy(output, "{\"error\":\"unsupported_command\"}");
    if (!strcmp(command, "session")) { Render(output, size); return; }
    char verb[9] = {}, suppliedOwner[33] = {}, id[33] = {}, user[57] = {}, secret[65] = {}, extra;
    unsigned long expected = 0;
    if (sscanf(command, "%8s %32s %c", verb, suppliedOwner, &extra) == 2 && Hex(suppliedOwner, 32)) {
        if (!strcmp(verb, "receipt")) {
            for (unsigned i = 0; i < receiptCount; ++i) if (!strcmp(receipts[i].id, suppliedOwner)) { RenderReceipt(receipts[i], output, size); return; }
            strcpy(output, "{\"error\":\"receipt_unknown\",\"guidance\":\"Do not replay with a new requestId.\"}"); return;
        }
        if (!strcmp(verb, "claim")) {
            if (*owner && strcmp(owner, suppliedOwner)) { strcpy(output, "{\"error\":\"owner_busy\"}"); return; }
            strcpy(owner, suppliedOwner); ownerTime = GetTickCount();
            strcpy(output, "{\"status\":\"owned\",\"ttlMs\":15000}"); return;
        }
        if (!strcmp(verb, "keep") || !strcmp(verb, "release")) {
            if (!*owner || strcmp(owner, suppliedOwner)) { strcpy(output, "{\"error\":\"owner_lost\"}"); return; }
            ownerTime = GetTickCount();
            if (!strcmp(verb, "release")) EndOwner();
            strcpy(output, "{\"status\":\"ok\"}"); return;
        }
    }
    int count = sscanf(command, "%8s %32s %32s %lu %56s %64s %c", verb, suppliedOwner, id, &expected, user, secret, &extra);
    if (count != 6 || strcmp(verb, "login") || !Hex(suppliedOwner, 32) || !Hex(id, 32) || !expected) {
        SecureZeroMemory(secret, sizeof(secret)); strcpy(output, "{\"error\":\"invalid_command\"}"); return;
    }
    BYTE digest[32];
    bool hashed = Digest(command, digest);
    if (!hashed) { SecureZeroMemory(secret, sizeof(secret)); strcpy(output, "{\"error\":\"digest_failed\"}"); return; }
    for (unsigned i = 0; i < receiptCount; ++i) if (!strcmp(receipts[i].id, id)) {
        if (memcmp(receipts[i].digest, digest, 32)) strcpy(output, "{\"error\":\"request_conflict\"}");
        else RenderReceipt(receipts[i], output, size);
        SecureZeroMemory(secret, sizeof(secret)); return;
    }
    const char* error = !*owner || strcmp(owner, suppliedOwner) ? "owner_lost"
        : !fresh ? "sample_stale" : expected != epoch ? "stale_epoch"
        : queued >= 0 ? "action_busy" : loginDispatched ? "login_already_dispatched"
        : !published.loginReady ? "login_unavailable" : receiptCount >= ReceiptLimit ? "receipt_capacity" : nullptr;
    if (!error && (!Decode(user, account, 15) || !Decode(secret, password, 17))) error = "invalid_credentials_shape";
    SecureZeroMemory(secret, sizeof(secret));
    if (error) {
        if (queued < 0) ClearCredentials();
        _snprintf(output, size, "{\"error\":\"%s\"}", error); return;
    }
    queued = static_cast<int>(receiptCount++);
    Receipt& receipt = receipts[queued];
    strcpy(receipt.id, id); memcpy(receipt.digest, digest, 32); receipt.epoch = expected;
    queuedAt = ownerTime = GetTickCount();
    RenderReceipt(receipt, output, size);
}
}
