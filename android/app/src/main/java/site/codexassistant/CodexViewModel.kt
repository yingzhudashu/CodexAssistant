package site.codexassistant

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class CodexViewModel(coordinator: SyncCoordinator) : ViewModel() {
    private val _state = MutableStateFlow(TaskState())
    val state = _state.asStateFlow()

    init {
        viewModelScope.launch { coordinator.state().collect { _state.value = it } }
    }
}
