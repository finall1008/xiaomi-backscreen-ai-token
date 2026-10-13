package dev.finall.aitoken.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.finall.aitoken.ProviderUiState
import dev.finall.aitoken.UsageUiState
import dev.finall.aitoken.model.ProviderId
import top.yukonga.miuix.kmp.basic.BasicComponent
import top.yukonga.miuix.kmp.basic.Button
import top.yukonga.miuix.kmp.basic.ButtonDefaults
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Scaffold
import top.yukonga.miuix.kmp.basic.SmallTitle
import top.yukonga.miuix.kmp.basic.Icon
import top.yukonga.miuix.kmp.icon.MiuixIcons
import top.yukonga.miuix.kmp.icon.basic.ArrowRight
import top.yukonga.miuix.kmp.basic.Switch
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TextField
import top.yukonga.miuix.kmp.basic.TopAppBar

@Composable
fun HomeScreen(
    state: UsageUiState,
    onOpenProvider: (ProviderId) -> Unit,
    onPublish: () -> Unit,
    onExport: () -> Unit,
    onAutomatic: (Boolean, Long) -> Unit,
    onMessage: (String) -> Unit,
) {
    val anyConfigured = state.providers.values.any { it.configured }
    var interval by remember(state.intervalMinutes) { mutableStateOf(state.intervalMinutes.toString()) }
    Scaffold(topBar = { TopAppBar(title = "AI 用量背屏") }) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                Column {
                    SmallTitle(text = "用量来源")
                    Card(Modifier.fillMaxWidth()) {
                    ProviderId.entries.forEach { id ->
                        val row = state.providers[id] ?: ProviderUiState()
                        BasicComponent(
                            title = id.displayName(),
                            summary = row.homeSummary(),
                            onClick = { onOpenProvider(id) },
                            endActions = { Icon(imageVector = MiuixIcons.Basic.ArrowRight, contentDescription = null) },
                        )
                    }
                    }
                }
            }
            val previewUrl = state.previewUrl
            if (anyConfigured && previewUrl != null) {
                item {
                    Card(Modifier.fillMaxWidth(), insideMargin = PaddingValues(0.dp)) {
                        CardPreview(previewUrl)
                    }
                }
            }
            item {
                Column {
                    SmallTitle(text = "背屏卡片")
                    Card(Modifier.fillMaxWidth()) {
                        BasicComponent(
                            title = "发送到背屏",
                            enabled = !state.busy && anyConfigured,
                            onClick = onPublish,
                            endActions = { Icon(imageVector = MiuixIcons.Basic.ArrowRight, contentDescription = null) },
                        )
                        BasicComponent(
                            title = "导出卡片 ZIP",
                            enabled = !state.busy && anyConfigured,
                            onClick = onExport,
                            endActions = { Icon(imageVector = MiuixIcons.Basic.ArrowRight, contentDescription = null) },
                        )
                    }
                    SmallTitle(text = "自动刷新")
                    Card(Modifier.fillMaxWidth()) {
                    BasicComponent(
                        title = "后台自动刷新",
                        summary = "已设置来源后定时刷新用量；绑定背屏后同时保存最新卡片。系统可能延迟执行。",
                        endActions = {
                            Switch(
                                checked = state.autoRefresh,
                                enabled = !state.busy && (anyConfigured || state.autoRefresh),
                                onCheckedChange = { enabled ->
                                    val minutes = interval.toLongOrNull()
                                    if (minutes == null || minutes < 15) onMessage("刷新间隔请输入至少 15 的整数")
                                    else onAutomatic(enabled, minutes)
                                },
                            )
                        },
                    )
                    TextField(
                        value = interval,
                        onValueChange = { interval = it },
                        label = "刷新间隔（分钟，至少 15）",
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                        enabled = !state.busy,
                    )
                    Button(
                        onClick = {
                            val minutes = interval.toLongOrNull()
                            if (minutes == null || minutes < 15) onMessage("刷新间隔请输入至少 15 的整数")
                            else onAutomatic(state.autoRefresh, minutes)
                        },
                        enabled = !state.busy,
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                    ) { Text("保存刷新设置") }
                    }
                }
            }
            item {
                Card(Modifier.fillMaxWidth()) {
                    BasicComponent(title = "最近状态", summary = state.status)
                }
            }
        }
    }
}
