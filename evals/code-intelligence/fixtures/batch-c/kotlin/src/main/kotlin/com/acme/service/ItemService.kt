package com.acme.service

import com.acme.model.Item

interface ItemLoader {
    fun find(id: String): Item
}

class ItemService : ItemLoader {
    override fun find(id: String): Item = Item(id)

    fun load(id: String): Item = find(id)

    fun load(id: Long): Item = find(id.toString())
}

fun Item.summary(): String = id

fun describe(item: Item): String = item.summary()
