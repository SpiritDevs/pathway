cmake_minimum_required(VERSION 3.25)
project(pathwaycomputeruse VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

# This is a Qt 6 / KF6 plugin, and ECM must be told so before any KDE module
# runs: without a version request (>= 5.240) or an explicit QT_MAJOR_VERSION,
# ECM's QtVersionOption defaults to Qt 5, and on a host that also has Qt 5
# installed KDEInstallDirs then loads Qt5Core, which pins
# QT_DEFAULT_MAJOR_VERSION=5 and makes the later find_package(Qt6) fail inside
# Qt6Qml's macros ("only available in Qt 6").
set(QT_MAJOR_VERSION 6)
find_package(ECM 5.240 REQUIRED NO_MODULE)
set(CMAKE_MODULE_PATH ${ECM_MODULE_PATH})

include(KDEInstallDirs)
include(KDECompilerSettings NO_POLICY_SCOPE)

find_package(Qt6 REQUIRED COMPONENTS Core DBus Gui Quick Widgets)
find_package(KF6CoreAddons REQUIRED)
find_package(KF6GlobalAccel REQUIRED)
find_package(KWin REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(XKBCOMMON REQUIRED IMPORTED_TARGET xkbcommon)

find_package(Git QUIET)
set(PATHWAY_GIT_SHORT_HASH "unknown")
if(GIT_FOUND)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -C "${CMAKE_SOURCE_DIR}" rev-parse --short=12 HEAD
        OUTPUT_VARIABLE PATHWAY_GIT_SHORT_HASH
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET
        RESULT_VARIABLE PATHWAY_GIT_RESULT
    )
    if(NOT PATHWAY_GIT_RESULT EQUAL 0 OR PATHWAY_GIT_SHORT_HASH STREQUAL "")
        set(PATHWAY_GIT_SHORT_HASH "unknown")
    endif()
endif()

set(PATHWAY_KWIN_VERSION "${KWin_VERSION}")
if(PATHWAY_KWIN_VERSION STREQUAL "" AND EXISTS "${KWin_DIR}/KWinConfigVersion.cmake")
    file(STRINGS "${KWin_DIR}/KWinConfigVersion.cmake" PATHWAY_KWIN_VERSION_LINE REGEX "^set\\(PACKAGE_VERSION ")
    string(REGEX MATCH "set\\(PACKAGE_VERSION \"([^\"]+)\"\\)" PATHWAY_KWIN_VERSION_MATCH "${PATHWAY_KWIN_VERSION_LINE}")
    set(PATHWAY_KWIN_VERSION "${CMAKE_MATCH_1}")
endif()
if(PATHWAY_KWIN_VERSION STREQUAL "")
    message(FATAL_ERROR "Could not determine the KWin version used to compile the plugin")
endif()

# The build id carries the configure time. For a reproducible build, set
# SOURCE_DATE_EPOCH (https://reproducible-builds.org/specs/source-date-epoch/):
# string(TIMESTAMP) stamps that instant instead of now, so two configures of
# the same source at the same KWin produce byte-identical build info. Checked
# here so a malformed value fails the configure rather than silently stamping
# the current time.
if(DEFINED ENV{SOURCE_DATE_EPOCH})
    if(NOT "$ENV{SOURCE_DATE_EPOCH}" MATCHES "^[0-9]+$")
        message(FATAL_ERROR "SOURCE_DATE_EPOCH must be a Unix timestamp, got '$ENV{SOURCE_DATE_EPOCH}'")
    endif()
    message(STATUS "Stamping the build from SOURCE_DATE_EPOCH=$ENV{SOURCE_DATE_EPOCH}")
endif()
string(TIMESTAMP PATHWAY_BUILD_TIMESTAMP "%Y-%m-%dT%H:%M:%SZ" UTC)
set(PATHWAY_BUILD_ID "${PATHWAY_GIT_SHORT_HASH}-${PATHWAY_BUILD_TIMESTAMP}")
configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/pathwaycomputerusebuildinfo.h.in"
    "${CMAKE_CURRENT_BINARY_DIR}/pathwaycomputerusebuildinfo.h"
    @ONLY
)

add_library(PathwayComputerUsePlugin MODULE
    pathwaycomputeruseplugin.cpp
    pathwaycomputeruseplugin.h
    main.cpp
    "${CMAKE_CURRENT_BINARY_DIR}/pathwaycomputerusebuildinfo.h"
)

target_include_directories(PathwayComputerUsePlugin PRIVATE
    "${CMAKE_CURRENT_BINARY_DIR}"
)

target_link_libraries(PathwayComputerUsePlugin PRIVATE
    KWin::kwin
    KF6::CoreAddons
    KF6::GlobalAccel
    Qt6::Core
    Qt6::DBus
    Qt6::Gui
    Qt6::Quick
    Qt6::Widgets
    PkgConfig::XKBCOMMON
)

set_target_properties(PathwayComputerUsePlugin PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/kwin/plugins"
    PREFIX ""
)

install(TARGETS PathwayComputerUsePlugin DESTINATION "${KDE_INSTALL_QTPLUGINDIR}/kwin/plugins")
install(FILES com.spiritdevs.pathway.ComputerUse.xml DESTINATION "${KDE_INSTALL_DBUSINTERFACEDIR}")

option(PATHWAY_BUILD_AUTH_PROBE "Build the isolated D-Bus authentication test fixture" OFF)
if(PATHWAY_BUILD_AUTH_PROBE)
    add_executable(PathwayComputerAuthProbe authprobe.cpp)
    target_link_libraries(PathwayComputerAuthProbe PRIVATE Qt6::Core Qt6::DBus)
endif()
