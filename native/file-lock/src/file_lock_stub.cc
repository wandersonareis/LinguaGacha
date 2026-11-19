// Plataformas sem bloqueio de exclusão nativo carregam um módulo vazio;
// o wrapper TypeScript trata a ausência das funções como "sem guard".
#include <node_api.h>

namespace {

napi_value init(napi_env env, napi_value exports) {
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
