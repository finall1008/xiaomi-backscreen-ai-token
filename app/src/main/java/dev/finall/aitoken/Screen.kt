package dev.finall.aitoken

import dev.finall.aitoken.model.ProviderId

sealed interface Screen : top.yukonga.miuix.kmp.nav.core.NavKey {
    data object Home : Screen
    data class ProviderDetail(val id: ProviderId) : Screen
    data object MimoLogin : Screen
}
