package site.codexassistant

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.serialization.json.*

class CodexViewModel(private val coordinator: SyncCoordinator) : ViewModel() {
    private val _state = MutableStateFlow(TaskState())
    val state = _state.asStateFlow()
    private val detailRequests = mutableMapOf<String, Pair<String, Boolean>>()
    init { viewModelScope.launch { coordinator.state().collect { incoming ->
        val old = _state.value
        var next = incoming.copy(details=old.details, sending=old.sending, results=old.results, loadingDetails=old.loadingDetails, detailErrors=old.detailErrors, submittingInteractions=old.submittingInteractions - incoming.interactionResults.filter { (id, result) -> old.interactionResults[id] !== result }.keys)
        incoming.details.forEach { (thread, detail) ->
            val pending=detailRequests[thread]
            if(pending?.first==detail.requestId) {
                val combined=if(pending.second) (old.details[thread]?.turns.orEmpty()+detail.turns) else detail.turns
                val seen=mutableSetOf<String>()
                val unique=combined.filter { value -> val id=((value as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull; id==null || seen.add(id) }
                next=next.copy(details=next.details+(thread to detail.copy(turns=unique)),loadingDetails=next.loadingDetails-thread)
                detailRequests.remove(thread)
            }
        }
        incoming.result?.let { result ->
            if(next.sending[result.threadId]==result.requestId) {
                val previous=next.results[result.threadId]
                val merged=if(result.status=="streaming" && previous?.requestId==result.requestId) result.copy(text=previous.text.orEmpty()+result.text.orEmpty()) else result
                next=next.copy(results=next.results+(result.threadId to merged), sending=if(result.status in listOf("completed","failed")) next.sending-result.threadId else next.sending)
            }
            val pending=detailRequests[result.threadId]
            if(pending?.first==result.requestId && result.status=="failed") {
                detailRequests.remove(result.threadId)
                next=next.copy(loadingDetails=next.loadingDetails-result.threadId,detailErrors=next.detailErrors+(result.threadId to (result.error?:"工作站未连接")))
            }
        }
        if (old.connected && !incoming.connected) {
            val interrupted = old.sending.mapValues { (thread, id) ->
                ResultMessage("result", PROTOCOL_VERSION, id, thread, "failed", error="连接中断，结果尚未确认，请读取回合摘要核实。消息不会自动重发。")
            }
            next = next.copy(sending=emptyMap(), results=next.results+interrupted,
                loadingDetails=emptySet(), detailErrors=next.detailErrors+old.loadingDetails.associateWith { "连接中断，请重新读取" },
                submittingInteractions=emptySet())
            detailRequests.clear()
        }
        _state.value=next
    } } }
    fun closeDetail(threadId:String) {
        detailRequests.remove(threadId)
        _state.value=_state.value.copy(details=_state.value.details-threadId,loadingDetails=_state.value.loadingDetails-threadId,detailErrors=_state.value.detailErrors-threadId)
    }
    fun loadDetail(threadId:String,cursor:String?=null) {
        if(threadId in _state.value.loadingDetails) return
        try {
            val id=coordinator.requestDetail(threadId,cursor)
            detailRequests[threadId]=id to (cursor!=null)
            _state.value=_state.value.copy(loadingDetails=_state.value.loadingDetails+threadId,detailErrors=_state.value.detailErrors-threadId)
            viewModelScope.launch { delay(30000);if(detailRequests[threadId]?.first==id){detailRequests.remove(threadId);_state.value=_state.value.copy(loadingDetails=_state.value.loadingDetails-threadId,detailErrors=_state.value.detailErrors+(threadId to "工作站未响应，请重试读取"))} }
        }catch(e:Exception){_state.value=_state.value.copy(detailErrors=_state.value.detailErrors+(threadId to (e.message?:"读取失败")))}
    }
    fun send(threadId:String,text:String): String? {
        if(!_state.value.connected) return null
        try {
            val id=coordinator.sendMessage(threadId,text)
            _state.value=_state.value.copy(sending=_state.value.sending+(threadId to id),results=_state.value.results-threadId)
            viewModelScope.launch { delay(120000);if(_state.value.sending[threadId]==id){_state.value=_state.value.copy(sending=_state.value.sending-threadId,results=_state.value.results+(threadId to ResultMessage("result",PROTOCOL_VERSION,id,threadId,"failed",error="结果尚未确认，请先读取回合摘要核实。消息不会自动重发。")))} }
            return id
        }catch(e:Exception){_state.value=_state.value.copy(results=_state.value.results+(threadId to ResultMessage("result",PROTOCOL_VERSION,"",threadId,"failed",error=e.message?:"发送失败")));return null}
    }
    fun submitInteraction(request: InteractionRequest, value: JsonElement) {
        if (!_state.value.connected || request.requestId in _state.value.submittingInteractions) return
        if (coordinator.submitInteraction(request.requestId, request.threadId, value)) {
            _state.value = _state.value.copy(submittingInteractions = _state.value.submittingInteractions + request.requestId)
            viewModelScope.launch {
                delay(30000)
                if (request.requestId in _state.value.submittingInteractions) {
                    _state.value = _state.value.copy(submittingInteractions = _state.value.submittingInteractions - request.requestId,
                        interactionResults = _state.value.interactionResults + (request.requestId to InteractionResult("interaction.result", PROTOCOL_VERSION, request.requestId, request.threadId, "failed", error="结果尚未确认。重试使用同一请求标识，不会重复执行。")))
                }
            }
        } else _state.value = _state.value.copy(interactionResults = _state.value.interactionResults + (request.requestId to InteractionResult("interaction.result", PROTOCOL_VERSION, request.requestId, request.threadId, "failed", error="连接不可用，请重连后重试")))
    }
}
