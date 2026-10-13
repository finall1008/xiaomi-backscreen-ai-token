package dev.finall.aitoken.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import dev.finall.aitoken.Screen
import dev.finall.aitoken.UsageUiState
import dev.finall.aitoken.model.ProviderId
import top.yukonga.miuix.kmp.nav.core.NavDisplay
import top.yukonga.miuix.kmp.nav.core.navBackStackOf
import top.yukonga.miuix.kmp.theme.ColorSchemeMode
import top.yukonga.miuix.kmp.theme.MiuixTheme
import top.yukonga.miuix.kmp.theme.ThemeController

@Composable
fun UsageScreen(
    state: UsageUiState,
    onOpenProvider: (ProviderId) -> Unit,
    onBack: () -> Unit,
    onCodexConnect: () -> Unit,
    onCancelLogin: () -> Unit,
    onCodexSignOut: () -> Unit,
    onSaveSecret: (ProviderId, String) -> Unit,
    onRefreshProvider: (ProviderId) -> Unit,
    onClearProvider: (ProviderId) -> Unit,
    onPublish: () -> Unit,
    onExport: () -> Unit,
    onAutomatic: (Boolean, Long) -> Unit,
    onMessage: (String) -> Unit,
) {
    val controller = remember { ThemeController(colorSchemeMode = ColorSchemeMode.System) }
    val backStack = remember { navBackStackOf(Screen.Home) }
    // External navigation (including notification intents) updates the official back stack.
    LaunchedEffect(state.screen) {
        when (val screen = state.screen) {
            Screen.Home -> while (backStack.size > 1) backStack.removeLastOrNull()
            is Screen.ProviderDetail -> if (backStack.lastOrNull() != screen) {
                while (backStack.size > 1) backStack.removeLastOrNull()
                backStack.add(screen)
            }
            Screen.MimoLogin -> if (backStack.lastOrNull() != screen) backStack.add(screen)
        }
    }
    val pop: () -> Unit = {
        if (backStack.lastOrNull() == Screen.MimoLogin) {
            backStack.removeLastOrNull()
        } else {
            if (backStack.size > 1) backStack.removeLastOrNull()
            onBack()
        }
    }
    MiuixTheme(controller = controller) {
        // Default Miuix transitions and predictive/swipe-back belong to NavDisplay.
        NavDisplay(backStack = backStack, onBack = pop) {
            entry<Screen.Home> {
                HomeScreen(state, onOpenProvider, onPublish, onExport, onAutomatic, onMessage)
            }
            entry<Screen.ProviderDetail> { screen ->
                ProviderScreen(
                    id = screen.id,
                    state = state,
                    onBack = pop,
                    onCodexConnect = onCodexConnect,
                    onCancelLogin = onCancelLogin,
                    onCodexSignOut = onCodexSignOut,
                    onSaveSecret = onSaveSecret,
                    onRefreshProvider = onRefreshProvider,
                    onClearProvider = onClearProvider,
                    onMessage = onMessage,
                    onMimoLogin = { backStack.add(Screen.MimoLogin) },
                )
            }
            entry<Screen.MimoLogin> {
                MimoWebLogin(
                    onBack = pop,
                    onCookie = { cookie ->
                        backStack.removeLastOrNull()
                        onSaveSecret(ProviderId.MIMO, cookie)
                    },
                )
            }
        }
    }
}
