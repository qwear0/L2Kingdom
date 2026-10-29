#pragma once

// Included after the checked memory helpers in agent.cpp. Native callbacks
// only copy game-thread observations; the RPC worker reads published copies.
namespace session {
using Login = int (__thiscall*)(void*, wchar_t*, wchar_t*);
using NoArgs = int (__thiscall*)(void*);
using OneInt = int (__thiscall*)(void*, int);
using VoidInt = void (__thiscall*)(void*, int);
using StackArg = int (__thiscall*)(void*, void*);
using AddServer = int (__thiscall*)(void*, int, wchar_t*, int, int, int, int);
using GameStart = int (__thiscall*)(void*, int, short, int, int, int);
struct UserRecord { BYTE bytes[0x248]; };
static_assert(sizeof(UserRecord) == 0x248, "Exact-build by-value User ABI");
using AddCharacter = void (__thiscall*)(void*, UserRecord);
using UserInfo = int (__thiscall*)(void*, void*, Vector, int, int, int, char);
Login login;
NoArgs authSuccess, serverSuccess;
OneInt authFailure, serverFailure, listStart, listEnd;
VoidInt characterStart, gameAccepted;
StackArg listAddStack, serverLogin;
AddServer listAdd;
AddCharacter characterAdd;
UserInfo userInfo;
GameStart gameStart;
void** networkTable;
void** notifyTable;
HMODULE engineModule, windowModule;
bool windowChecked;
DWORD gameThread;
void* currentEngine;
volatile LONG wrongThread;
constexpr unsigned ServerLimit = 32, CharacterLimit = 7, NameCapacity = 65;
struct Server { DWORD id, address, port; };
struct State {
    int phase, failure, characterExpected, gameAccepted;
    DWORD revision, listEntries, serverCount, characterCount, selectedServer;
    bool handlerValid, authTransport, gameTransport, loginReady, serverReady, characterReady;
    bool serverListValid, characterListValid, selfMatches, pawnObserved, worldEntered;
    Server servers[ServerLimit];
    wchar_t characters[CharacterLimit][NameCapacity], selectedCharacter[NameCapacity];
};
State nativeState, published;
enum PhaseId { Initial, AuthAccepted, AuthRejected, ServerReceiving, ServerReady, GameHandoff, ServerRejected,
    CharacterReceiving, CharacterReady, EnteringWorld, WorldReady, GameRejected, ServerDispatch, SessionLost };
const char* phases[] = {"no_auth_observed", "auth_accepted_consent_unverified", "auth_rejected",
    "server_list_receiving", "server_list_ready", "game_handoff", "server_rejected", "character_list_receiving",
    "character_list_ready", "entering_world", "world_ready", "game_rejected", "server_selection_dispatched", "session_lost"};

bool Callback(void* self) {
    if (GetCurrentThreadId() != gameThread) { InterlockedIncrement(&wrongThread); return false; }
    return currentEngine && self == static_cast<BYTE*>(currentEngine) + c4::EngineNotify;
}
void Phase(int value, int failure = 0) {
    nativeState.phase = value;
    nativeState.failure = failure;
    ++nativeState.revision;
}
bool CopyName(const wchar_t* input, wchar_t* output) {
    for (unsigned i = 0; i < NameCapacity; ++i) {
        if (!Readable(input + i, sizeof(wchar_t))) return false;
        output[i] = input[i];
        if (!input[i]) return i > 0;
    }
    output[0] = 0;
    return false;
}
int __fastcall AuthSuccess(void* self, void*) {
    if (Callback(self)) Phase(AuthAccepted);
    return authSuccess(self);
}
int __fastcall AuthFailure(void* self, void*, int code) {
    if (Callback(self)) Phase(AuthRejected, code);
    return authFailure(self, code);
}
int __fastcall ServerSuccess(void* self, void*) {
    if (Callback(self)) Phase(GameHandoff);
    return serverSuccess(self);
}
int __fastcall ServerFailure(void* self, void*, int code) {
    if (Callback(self)) Phase(ServerRejected, code);
    return serverFailure(self, code);
}
int __fastcall ListStart(void* self, void*, int count) {
    if (Callback(self)) {
        nativeState.listEntries = nativeState.serverCount = 0;
        nativeState.serverListValid = count >= 0 && count <= static_cast<int>(ServerLimit);
        Phase(ServerReceiving);
    }
    return listStart(self, count);
}
int __fastcall ListEnd(void* self, void*, int value) {
    if (Callback(self)) Phase(ServerReady);
    return listEnd(self, value);
}
int __fastcall ListAddStack(void* self, void*, void* stack) {
    if (Callback(self)) {
        ++nativeState.listEntries;
        // Top advances +8. Copy the first three *values*, without consuming the
        // original stack or retaining its pointers. The UI selects id/address/
        // port in this order; RequestServerLogin reads exactly those three.
        struct ParamStack { DWORD* values; int capacity, index, count; };
        auto args = static_cast<ParamStack*>(stack);
        bool valid = Readable(args, sizeof(*args)) && args->index >= 0 && args->capacity >= args->count
            && args->count - args->index >= 3 && args->count <= 32
            && Readable(args->values + args->index, 3 * sizeof(DWORD));
        if (valid && nativeState.serverCount < ServerLimit) {
            DWORD* values = args->values + args->index;
            Server entry = {values[0], values[1], values[2]};
            valid = entry.id > 0 && entry.id <= 255 && entry.address && entry.port > 0 && entry.port <= 65535;
            for (unsigned i = 0; i < nativeState.serverCount; ++i) if (nativeState.servers[i].id == entry.id) valid = false;
            if (valid) nativeState.servers[nativeState.serverCount++] = entry;
        } else valid = false;
        if (!valid) nativeState.serverListValid = false;
    }
    return listAddStack(self, stack);
}
int __fastcall ListAdd(void* self, void*, int id, wchar_t* name, int a, int b, int c, int d) {
    if (Callback(self)) { ++nativeState.listEntries; nativeState.serverListValid = false; }
    return listAdd(self, id, name, a, b, c, d);
}
void __fastcall CharacterStart(void* self, void*, int count) {
    if (Callback(self)) {
        nativeState.characterExpected = count;
        nativeState.characterCount = 0;
        nativeState.characterListValid = count >= 0 && count <= static_cast<int>(CharacterLimit);
        nativeState.gameAccepted = 0;
        nativeState.selfMatches = false;
        nativeState.selectedCharacter[0] = 0;
        Phase(count == 0 ? CharacterReady : CharacterReceiving);
    }
    characterStart(self, count);
}
void __fastcall CharacterAdd(void* self, void*, UserRecord user) {
    bool observed = Callback(self);
    if (observed) {
        unsigned index = nativeState.characterCount++;
        if (index >= CharacterLimit || nativeState.phase != CharacterReceiving
            || !CopyName(reinterpret_cast<wchar_t*>(user.bytes + 0x1c), nativeState.characters[index])) {
            nativeState.characterListValid = false;
        }
    }
    characterAdd(self, user);
    if (observed && nativeState.characterCount == static_cast<unsigned>(nativeState.characterExpected)) Phase(CharacterReady);
}
void __fastcall GameAccepted(void* self, void*, int accepted) {
    if (Callback(self)) {
        nativeState.gameAccepted = accepted;
        if (!accepted) Phase(GameRejected, accepted);
    }
    gameAccepted(self, accepted);
}
int __fastcall SelfInfo(void* self, void*, void* user, Vector location, int a, int b, int c, char d) {
    if (Callback(self)) {
        wchar_t name[NameCapacity] = {};
        nativeState.selfMatches = Readable(user, 0x248)
            && CopyName(reinterpret_cast<wchar_t*>(static_cast<BYTE*>(user) + 0x1c), name)
            && nativeState.selectedCharacter[0] && !wcscmp(name, nativeState.selectedCharacter);
    }
    return userInfo(self, user, location, a, b, c, d);
}

bool Install(HMODULE module) {
    engineModule = module;
    networkTable = reinterpret_cast<void**>(GetProcAddress(module, "??_7UNetworkHandler@@6BUObject@@@"));
    notifyTable = reinterpret_cast<void**>(GetProcAddress(module, "??_7UGameEngine@@6B@"));
    login = reinterpret_cast<Login>(GetProcAddress(module, "?RequestAuthLogin@UNetworkHandler@@UAEHPAG0@Z"));
    serverLogin = reinterpret_cast<StackArg>(GetProcAddress(module, "?RequestServerLogin@UNetworkHandler@@UAEHAAVL2ParamStack@@@Z"));
    gameStart = reinterpret_cast<GameStart>(GetProcAddress(module, "?RequestGameStart@UNetworkHandler@@UAEHHFHHH@Z"));
    struct Hook { unsigned offset; const char* symbol; void* replacement; void** original; };
    Hook hooks[] = {
        {0x38, "?OnUserInfo@UGameEngine@@UAEHPAUUser@@VFVector@@HHHD@Z", reinterpret_cast<void*>(&SelfInfo), reinterpret_cast<void**>(&userInfo)},
        {0x70, "?OnAuthLoginSuccess@UGameEngine@@UAEHXZ", reinterpret_cast<void*>(&AuthSuccess), reinterpret_cast<void**>(&authSuccess)},
        {0x74, "?OnStartServerList@UGameEngine@@UAEHH@Z", reinterpret_cast<void*>(&ListStart), reinterpret_cast<void**>(&listStart)},
        {0x78, "?OnAddServerList@UGameEngine@@UAEHAAVL2ParamStack@@@Z", reinterpret_cast<void*>(&ListAddStack), reinterpret_cast<void**>(&listAddStack)},
        {0x7c, "?OnAddServerList@UGameEngine@@UAEHHPAGHHHH@Z", reinterpret_cast<void*>(&ListAdd), reinterpret_cast<void**>(&listAdd)},
        {0x80, "?OnEndServerList@UGameEngine@@UAEHH@Z", reinterpret_cast<void*>(&ListEnd), reinterpret_cast<void**>(&listEnd)},
        {0x84, "?OnAuthLoginFail@UGameEngine@@UAEHH@Z", reinterpret_cast<void*>(&AuthFailure), reinterpret_cast<void**>(&authFailure)},
        {0x94, "?OnAuthServerSelectSuccess@UGameEngine@@UAEHXZ", reinterpret_cast<void*>(&ServerSuccess), reinterpret_cast<void**>(&serverSuccess)},
        {0x98, "?OnAuthServerSelectFail@UGameEngine@@UAEHH@Z", reinterpret_cast<void*>(&ServerFailure), reinterpret_cast<void**>(&serverFailure)},
        {0x218, "?OnReceiveCharacterInfo@UGameEngine@@UAEXH@Z", reinterpret_cast<void*>(&CharacterStart), reinterpret_cast<void**>(&characterStart)},
        {0x21c, "?AddCharacterInfo@UGameEngine@@UAEXUUser@@@Z", reinterpret_cast<void*>(&CharacterAdd), reinterpret_cast<void**>(&characterAdd)},
        {0x220, "?OnAcceptGameStart@UGameEngine@@UAEXH@Z", reinterpret_cast<void*>(&GameAccepted), reinterpret_cast<void**>(&gameAccepted)}
    };
    if (!login || !serverLogin || !gameStart || !Readable(networkTable, 0x144) || !Readable(notifyTable, 0x224)
        || networkTable[0x13c / 4] != reinterpret_cast<void*>(serverLogin) || networkTable[0x140 / 4] != reinterpret_cast<void*>(gameStart)) return false;
    for (auto& hook : hooks) {
        auto address = reinterpret_cast<void*>(GetProcAddress(module, hook.symbol));
        if (!address || notifyTable[hook.offset / 4] != address) return false;
        *hook.original = address;
    }
    DWORD protection = 0;
    if (!VirtualProtect(notifyTable, 0x224, PAGE_READWRITE, &protection)) return false;
    for (auto& hook : hooks) InterlockedExchangePointer(notifyTable + hook.offset / 4, hook.replacement);
    DWORD ignored = 0;
    return VirtualProtect(notifyTable, 0x224, protection, &ignored) != 0;
}

// Called only on the serial RPC worker, before taking sampleLock. NWindow is
// loaded later than Engine; hash its actual module path once, off the game thread.
void ResolveWindow() {
    if (windowChecked) return;
    HMODULE module = GetModuleHandleA("NWindow.dll");
    if (!module) return;
    char path[MAX_PATH];
    DWORD n = GetModuleFileNameA(module, path, sizeof(path));
    bool valid = n && n < sizeof(path) && c4::HashMatches(path, c4::Identities[3].sha256);
    EnterCriticalSection(&sampleLock);
    windowModule = valid ? module : nullptr;
    windowChecked = true;
    LeaveCriticalSection(&sampleLock);
}
void* WindowConsole(void* engine, void* handler) {
    void* console = PointerAt(engine, c4::EngineConsole);
    if (!windowModule || !Readable(console, 0x3c98)
        || PointerAt(console, 0) != reinterpret_cast<BYTE*>(windowModule) + c4::WindowConsoleTable
        || PointerAt(console, 0x54) != engine || PointerAt(engine, 0x64) != handler) return nullptr;
    void* ui = PointerAt(console, 0x3be0);
    if (!Readable(PointerAt(console, 0x3be8), sizeof(void*)) || !Readable(PointerAt(console, 0x3bf0), sizeof(void*))
        || !Readable(PointerAt(ui, 0xf0), sizeof(void*)) || !Readable(PointerAt(ui, 0xfc), sizeof(void*))) return nullptr;
    return console;
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
enum Action { LoginAction, ServerAction, CharacterAction };
struct Receipt {
    char id[33];
    BYTE digest[32];
    DWORD epoch, revision;
    int status, nativeReturn, action, selection;
};
Receipt receipts[ReceiptLimit];
unsigned receiptCount;
int queued = -1;
bool loginDispatched;
DWORD queuedAt, ownerTime;
char owner[33];
wchar_t account[15], password[17];
const char* statuses[] = {"queued", "dispatched", "stale_epoch", "owner_lost", "native_unavailable", "native_rejected", "queue_expired", "stale_revision"};
const char* actions[] = {"login", "select_server", "select_character"};

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
    nativeState.pawnObserved = pawn;
    nativeState.worldEntered = (nativeState.phase == EnteringWorld || nativeState.phase == WorldReady)
        && handler && nativeState.gameTransport && pawn && nativeState.selfMatches && nativeState.gameAccepted == 1;
    if (nativeState.worldEntered && nativeState.phase == EnteringWorld) Phase(WorldReady);
    if (nativeState.phase == WorldReady && !nativeState.worldEntered) Phase(SessionLost);
    nativeState.loginReady = handler && !pawn && !loginDispatched && !nativeState.authTransport && !nativeState.gameTransport
        && Readable(auth, c4::AuthDriverFields) && Readable(game, c4::DriverTransport + sizeof(void*))
        && !*reinterpret_cast<int*>(static_cast<BYTE*>(handler) + c4::NetworkAuthPending)
        && Readable(PointerAt(engine, c4::EngineConsole), sizeof(void*)) && nativeState.phase == Initial;
    nativeState.serverReady = handler && !pawn && nativeState.authTransport && nativeState.phase == ServerReady
        && nativeState.serverListValid && nativeState.serverCount && nativeState.serverCount == nativeState.listEntries;
    // The original console RequestGameStart supplies zero pad/coordinates only
    // when +0x3c94 is disabled. Never guess security-pad answers or bypass it.
    void* console = WindowConsole(engine, handler);
    bool noPad = console && !*reinterpret_cast<int*>(static_cast<BYTE*>(console) + 0x3c94);
    nativeState.characterReady = handler && !pawn && nativeState.gameTransport && nativeState.phase == CharacterReady && noPad
        && nativeState.characterListValid && nativeState.characterCount > 0
        && nativeState.characterCount == static_cast<unsigned>(nativeState.characterExpected);
    ExpireOwner();
    if (queued >= 0) {
        Receipt& receipt = receipts[queued];
        bool ready = receipt.action == LoginAction ? nativeState.loginReady
            : receipt.action == ServerAction ? nativeState.serverReady : nativeState.characterReady;
        if (GetTickCount() - queuedAt >= 10000) receipt.status = 6;
        else if (receipt.epoch != epoch) receipt.status = 2;
        else if (receipt.action != LoginAction && receipt.revision != nativeState.revision) receipt.status = 7;
        else if (!ready) receipt.status = 4;
        else {
            // A native return is dispatch only. Network callbacks, matching
            // self UserInfo and a later checked pawn establish world entry.
            if (receipt.action == LoginAction) {
                loginDispatched = true;
                receipt.nativeReturn = login(handler, account, password);
                nativeState.loginReady = false;
            } else if (receipt.action == ServerAction) {
                Server entry = nativeState.servers[receipt.selection];
                DWORD values[] = {entry.id, entry.address, entry.port};
                // This call only uses Top: no allocation/destruction or ownership
                // transfer. Match its verified 16-byte L2ParamStack read layout.
                struct { DWORD* values; int capacity, index, count; } stack = {values, 3, 0, 3};
                nativeState.selectedServer = entry.id;
                Phase(ServerDispatch);
                receipt.nativeReturn = serverLogin(handler, &stack);
                nativeState.serverReady = false;
            } else {
                wcscpy(nativeState.selectedCharacter, nativeState.characters[receipt.selection]);
                nativeState.selfMatches = false;
                nativeState.gameAccepted = 0;
                Phase(EnteringWorld);
                // Use the verified console wrapper, not only the network call:
                // it also closes the selection UI and prepares the world HUD.
                auto start = reinterpret_cast<OneInt>(reinterpret_cast<BYTE*>(windowModule) + c4::WindowGameStart);
                receipt.nativeReturn = start(console, receipt.selection);
                nativeState.characterReady = false;
            }
            receipt.status = receipt.nativeReturn == 1 ? 1 : 5;
        }
        queued = -1;
        ClearCredentials();
    }
    published = nativeState;
}

bool Hex(const char* value, unsigned size) {
    if (strlen(value) != size) return false;
    for (unsigned i = 0; i < size; ++i) if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
    return true;
}
unsigned Nibble(char c) { return c <= '9' ? c - '0' : c - 'a' + 10; }
bool Decode(const char* hex, wchar_t* output, unsigned capacity, bool ascii = true) {
    unsigned size = static_cast<unsigned>(strlen(hex));
    if (!size || size % 4 || size / 4 >= capacity || !Hex(hex, size)) return false;
    for (unsigned i = 0; i < size / 4; ++i) {
        unsigned low = Nibble(hex[i * 4]) * 16 + Nibble(hex[i * 4 + 1]);
        unsigned high = Nibble(hex[i * 4 + 2]) * 16 + Nibble(hex[i * 4 + 3]);
        unsigned value = low + high * 256;
        if (!value || (ascii && (value < 0x21 || value > 0x7e))) return false;
        output[i] = static_cast<wchar_t>(value);
    }
    output[size / 4] = 0;
    return true;
}
void EncodeName(const wchar_t* input, char* output) {
    const char* hex = "0123456789abcdef";
    unsigned i = 0;
    for (; i < NameCapacity - 1 && input[i]; ++i) {
        unsigned v = input[i];
        output[i * 4] = hex[(v >> 4) & 15]; output[i * 4 + 1] = hex[v & 15];
        output[i * 4 + 2] = hex[(v >> 12) & 15]; output[i * 4 + 3] = hex[(v >> 8) & 15];
    }
    output[i * 4] = 0;
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
    // Render runs only on the serial RPC worker, never on the game thread.
    static char servers[512], characters[2048], name[257];
    servers[0] = characters[0] = 0;
    unsigned used = 0;
    for (unsigned i = 0; i < published.serverCount; ++i) {
        int n = _snprintf(servers + used, sizeof(servers) - used, "%s%lu", i ? "," : "", published.servers[i].id);
        if (n < 0 || static_cast<unsigned>(n) >= sizeof(servers) - used) { strcpy(output, "{\"error\":\"session_overflow\"}"); return; }
        used += n;
    }
    used = 0;
    for (unsigned i = 0; i < published.characterCount && i < CharacterLimit; ++i) {
        EncodeName(published.characters[i], name);
        int n = _snprintf(characters + used, sizeof(characters) - used, "%s\"%s\"", i ? "," : "", name);
        if (n < 0 || static_cast<unsigned>(n) >= sizeof(characters) - used) { strcpy(output, "{\"error\":\"session_overflow\"}"); return; }
        used += n;
    }
    EncodeName(published.selectedCharacter, name);
    int n = _snprintf(output, size,
        "{\"source\":\"client_network\",\"state\":\"%s\",\"revision\":%lu,\"nativeFailureCode\":%d,\"handlerValid\":%s,\"authTransportPresent\":%s,\"gameTransportPresent\":%s,\"serverListCallbacks\":%lu,\"loginReady\":%s,\"serverSelectionReady\":%s,\"characterSelectionReady\":%s,\"serverListValid\":%s,\"characterListValid\":%s,\"serverIds\":[%s],\"characterNamesUtf16le\":[%s],\"selectedServerId\":%lu,\"selectedCharacterUtf16le\":\"%s\",\"gameStartAccepted\":%d,\"selfMatchesSelection\":%s,\"pawnObserved\":%s,\"worldEntered\":%s,\"ownerActive\":%s,\"wrongThreadCallbacks\":%ld,\"consent\":\"unverified_no_automatic_acceptance\"}",
        phases[published.phase], published.revision, published.failure, published.handlerValid ? "true" : "false",
        published.authTransport ? "true" : "false", published.gameTransport ? "true" : "false", published.listEntries,
        published.loginReady && queued < 0 ? "true" : "false", published.serverReady && queued < 0 ? "true" : "false",
        published.characterReady && queued < 0 ? "true" : "false", published.serverListValid ? "true" : "false",
        published.characterListValid ? "true" : "false", servers, characters, published.selectedServer, name,
        published.gameAccepted, published.selfMatches ? "true" : "false", published.pawnObserved ? "true" : "false",
        published.worldEntered ? "true" : "false", *owner ? "true" : "false", wrongThread);
    if (n < 0 || static_cast<unsigned>(n) >= size) strcpy(output, "{\"error\":\"session_overflow\"}");
}
void RenderReceipt(const Receipt& receipt, char* output, unsigned size) {
    _snprintf(output, size, "{\"requestId\":\"%s\",\"epoch\":%lu,\"action\":\"%s\",\"status\":\"%s\",\"nativeReturn\":%d}",
        receipt.id, receipt.epoch, actions[receipt.action], statuses[receipt.status], receipt.nativeReturn);
}

// Called with sampleLock held. Parsing/digests/disk-free transport stay on the
// RPC worker; the game thread consumes only the fixed-size action mailbox.
void Rpc(const char* command, DWORD epoch, bool fresh, char* output, unsigned size) {
    ExpireOwner();
    strcpy(output, "{\"error\":\"unsupported_command\"}");
    if (!strcmp(command, "session")) { Render(output, size); return; }
    char verb[9] = {}, suppliedOwner[33] = {}, id[33] = {}, user[257] = {}, secret[65] = {}, extra;
    unsigned long expected = 0, revision = 0, server = 0;
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
    int action = -1, selection = -1;
    if (!strcmp(verb, "login")) {
        if (sscanf(command, "%8s %32s %32s %lu %56s %64s %c", verb, suppliedOwner, id, &expected, user, secret, &extra) == 6) action = LoginAction;
    } else if (!strcmp(verb, "server")) {
        if (sscanf(command, "%8s %32s %32s %lu %lu %lu %c", verb, suppliedOwner, id, &expected, &revision, &server, &extra) == 6
            && server > 0 && server <= 255) action = ServerAction;
    } else if (!strcmp(verb, "char")) {
        if (sscanf(command, "%8s %32s %32s %lu %lu %256s %c", verb, suppliedOwner, id, &expected, &revision, user, &extra) == 6) action = CharacterAction;
    }
    if (action < 0 || !Hex(suppliedOwner, 32) || !Hex(id, 32) || !expected) {
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
    bool ready = action == LoginAction ? published.loginReady : action == ServerAction ? published.serverReady : published.characterReady;
    const char* error = !*owner || strcmp(owner, suppliedOwner) ? "owner_lost"
        : !fresh ? "sample_stale" : expected != epoch ? "stale_epoch"
        : queued >= 0 ? "action_busy" : action != LoginAction && revision != published.revision ? "stale_revision"
        : !ready ? "action_unavailable" : receiptCount >= ReceiptLimit ? "receipt_capacity" : nullptr;
    if (!error && action == LoginAction && (!Decode(user, account, 15) || !Decode(secret, password, 17))) error = "invalid_credentials_shape";
    if (!error && action == ServerAction) {
        for (unsigned i = 0; i < published.serverCount; ++i) if (published.servers[i].id == server) selection = static_cast<int>(i);
        if (selection < 0) error = "server_not_observed";
    }
    if (!error && action == CharacterAction) {
        wchar_t name[NameCapacity] = {};
        if (!Decode(user, name, NameCapacity, false)) error = "invalid_character_name";
        else {
            for (unsigned i = 0; i < published.characterCount && i < CharacterLimit; ++i) if (!wcscmp(name, published.characters[i])) {
                if (selection >= 0) { error = "character_ambiguous"; break; }
                selection = static_cast<int>(i);
            }
            if (selection < 0) error = "character_not_observed";
        }
    }
    SecureZeroMemory(secret, sizeof(secret));
    if (error) {
        if (queued < 0) ClearCredentials();
        _snprintf(output, size, "{\"error\":\"%s\"}", error); return;
    }
    queued = static_cast<int>(receiptCount++);
    Receipt& receipt = receipts[queued];
    strcpy(receipt.id, id); memcpy(receipt.digest, digest, 32); receipt.epoch = expected;
    receipt.revision = revision; receipt.action = action; receipt.selection = selection;
    queuedAt = ownerTime = GetTickCount();
    RenderReceipt(receipt, output, size);
}
}
