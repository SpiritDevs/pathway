cmake_minimum_required(VERSION 3.22.1)

project(pathwayterminal LANGUAGES CXX)

add_library(ghostty-vt SHARED IMPORTED)
set_target_properties(
  ghostty-vt
  PROPERTIES IMPORTED_LOCATION
             "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libghostty-vt.so"
)

add_library(pathwayterminal SHARED pathway_terminal_jni.cpp)

target_include_directories(
  pathwayterminal
  PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../../../native/libghostty-vt/include"
)

target_link_options(
  pathwayterminal PRIVATE "-Wl,-z,common-page-size=16384" "-Wl,-z,max-page-size=16384"
)

target_link_libraries(pathwayterminal PRIVATE ghostty-vt log)
