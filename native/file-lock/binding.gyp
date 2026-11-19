{
  "targets": [
    {
      "target_name": "file_lock",
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": ["src/file_lock_win.cc"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            }
          },
          {
            "sources": ["src/file_lock_stub.cc"]
          }
        ]
      ]
    }
  ]
}
