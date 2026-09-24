/*
    SPDX-FileCopyrightText: 2026 Pathway

    SPDX-License-Identifier: GPL-2.0-only OR GPL-3.0-only OR LicenseRef-KDE-Accepted-GPL
*/

#include "plugin.h"

#include "pathwaycomputeruseplugin.h"

class KWIN_EXPORT PathwayComputerUsePluginFactory : public KWin::PluginFactory
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID PluginFactory_iid FILE "metadata.json")
    Q_INTERFACES(KWin::PluginFactory)

public:
    std::unique_ptr<KWin::Plugin> create() const override
    {
        return std::make_unique<KWin::PathwayComputerUsePlugin>();
    }
};

#include "main.moc"
