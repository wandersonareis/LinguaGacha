// Mantém um handle de diretório sem FILE_SHARE_DELETE: o Windows recusa
// renomear ou apagar o diretório enquanto este handle estiver aberto.
#include <node_api.h>
#include <windows.h>

#include <cstdint>
#include <string>
#include <unordered_map>

namespace {

std::unordered_map<uint32_t, HANDLE> handles;
uint32_t next_token = 1;

void throw_last_error(napi_env env, const char* operation, DWORD code) {
  std::string message = operation;
  message += " failed with Win32 error ";
  message += std::to_string(code);
  napi_throw_error(env, nullptr, message.c_str());
}

napi_value hold_no_delete(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    napi_throw_type_error(env, nullptr, "hold_no_delete requires a path");
    return nullptr;
  }

  size_t length = 0;
  if (napi_get_value_string_utf16(env, argv[0], nullptr, 0, &length) != napi_ok) {
    napi_throw_type_error(env, nullptr, "path must be a string");
    return nullptr;
  }
  std::wstring native_path(length + 1, L'\0');
  napi_get_value_string_utf16(
      env, argv[0], reinterpret_cast<char16_t*>(native_path.data()), native_path.size(), &length);

  HANDLE handle = CreateFileW(native_path.c_str(), FILE_READ_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                              FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    throw_last_error(env, "CreateFileW", GetLastError());
    return nullptr;
  }

  const uint32_t token = next_token++;
  handles[token] = handle;
  napi_value result = nullptr;
  napi_create_uint32(env, token, &result);
  return result;
}

napi_value release_no_delete(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    napi_throw_type_error(env, nullptr, "release_no_delete requires a token");
    return nullptr;
  }

  uint32_t token = 0;
  if (napi_get_value_uint32(env, argv[0], &token) != napi_ok) {
    napi_throw_type_error(env, nullptr, "token must be a uint32");
    return nullptr;
  }

  const auto found = handles.find(token);
  if (found == handles.end()) {
    return nullptr;
  }
  CloseHandle(found->second);
  handles.erase(found);
  return nullptr;
}

napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
      {"hold_no_delete", nullptr, hold_no_delete, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release_no_delete", nullptr, release_no_delete, nullptr, nullptr, nullptr, napi_default,
       nullptr},
  };
  napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
