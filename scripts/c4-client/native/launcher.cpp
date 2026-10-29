#include "profile.h"

static bool RemoteCall(HANDLE process, LPTHREAD_START_ROUTINE function, void* argument, DWORD* result) {
    HANDLE thread = CreateRemoteThread(process, nullptr, 0, function, argument, 0, nullptr);
    if (!thread) return false;
    bool ok = WaitForSingleObject(thread, 30000) == WAIT_OBJECT_0
        && GetExitCodeThread(thread, result);
    CloseHandle(thread);
    return ok;
}

static int Launch() {
    char session[MAX_PATH];
    DWORD sessionLength = GetEnvironmentVariableA("C4_AGENT_SESSION", session, sizeof(session));
    if (!sessionLength || sessionLength >= sizeof(session)) {
        fprintf(stderr, "C4 P0: C4_AGENT_SESSION must name a precreated private descriptor file.\n");
        return 1;
    }
    if (!c4::VerifyBuild(false)) {
        fprintf(stderr, "C4 P0: unsupported or unreadable client identity; no child launched.\n");
        return 2;
    }
    char dll[MAX_PATH];
    DWORD length = GetModuleFileNameA(nullptr, dll, sizeof(dll));
    if (!length || length >= sizeof(dll)) return 3;
    char* slash = strrchr(dll, '\\');
    if (!slash || static_cast<unsigned>(slash - dll) + sizeof("\\C4Agent.dll") > sizeof(dll)) return 3;
    strcpy(slash, "\\C4Agent.dll");
    HMODULE local = LoadLibraryExA(dll, nullptr, DONT_RESOLVE_DLL_REFERENCES);
    if (!local) return 3;
    FARPROC start = GetProcAddress(local, "C4AgentStart");
    DWORD startRva = start ? static_cast<DWORD>(reinterpret_cast<BYTE*>(start) - reinterpret_cast<BYTE*>(local)) : 0;
    FreeLibrary(local);
    if (!startRva) return 3;

    HCRYPTPROV provider = 0;
    BYTE random[32];
    if (!CryptAcquireContextA(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) return 4;
    bool randomOk = CryptGenRandom(provider, sizeof(random), random);
    CryptReleaseContext(provider, 0);
    if (!randomOk) return 4;
    char token[65];
    for (unsigned i = 0; i < sizeof(random); ++i) _snprintf(token + i * 2, 3, "%02x", random[i]);
    if (!SetEnvironmentVariableA("C4_AGENT_TOKEN", token)) return 4;

    STARTUPINFOA startup = {};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child = {};
    char command[] = "L2.exe -windowed";
    // Injection is restricted to this newly created child. No attach-by-PID or
    // process discovery is supported; any setup failure terminates only it.
    if (!CreateProcessA("L2.exe", command, nullptr, nullptr, FALSE, CREATE_SUSPENDED, nullptr, nullptr, &startup, &child)) return 5;
    SetEnvironmentVariableA("C4_AGENT_TOKEN", nullptr);
    char eventName[80];
    c4::ReadyEventName(eventName, sizeof(eventName), child.dwProcessId);
    HANDLE ready = CreateEventA(nullptr, TRUE, FALSE, eventName);
    bool newEvent = ready && GetLastError() != ERROR_ALREADY_EXISTS;
    void* remote = VirtualAllocEx(child.hProcess, nullptr, strlen(dll) + 1, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    DWORD module = 0, started = 0;
    SIZE_T written = 0;
    bool ok = newEvent && remote
        && WriteProcessMemory(child.hProcess, remote, dll, strlen(dll) + 1, &written)
        && written == strlen(dll) + 1
        && RemoteCall(child.hProcess, reinterpret_cast<LPTHREAD_START_ROUTINE>(GetProcAddress(GetModuleHandleA("kernel32.dll"), "LoadLibraryA")), remote, &module)
        && module
        && RemoteCall(child.hProcess, reinterpret_cast<LPTHREAD_START_ROUTINE>(module + startRva), nullptr, &started)
        && started == 1
        && WaitForSingleObject(ready, 30000) == WAIT_OBJECT_0;
    if (ok) {
        VirtualFreeEx(child.hProcess, remote, 0, MEM_RELEASE);
        ok = ResumeThread(child.hThread) != static_cast<DWORD>(-1);
    }
    if (ready) CloseHandle(ready);
    CloseHandle(child.hThread);
    if (!ok) {
        fprintf(stderr, "C4 P0: child setup failed (Windows error %lu).\n", GetLastError());
        TerminateProcess(child.hProcess, 6);
        WaitForSingleObject(child.hProcess, 10000);
        CloseHandle(child.hProcess);
        DeleteFileA(session);
        return 6;
    }
    printf("C4 P0: owned client PID %lu; profile %s.\n", child.dwProcessId, c4::Profile);
    fflush(stdout);
    WaitForSingleObject(child.hProcess, INFINITE);
    DWORD code = 0;
    bool gotCode = GetExitCodeProcess(child.hProcess, &code);
    CloseHandle(child.hProcess);
    DeleteFileA(session);
    return gotCode ? static_cast<int>(code) : 7;
}

extern "C" void mainCRTStartup() { ExitProcess(Launch()); }
