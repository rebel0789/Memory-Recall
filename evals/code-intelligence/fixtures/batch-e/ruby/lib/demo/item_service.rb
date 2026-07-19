require_relative "item"

module Demo
  module Logging
    def log_item(id)
      id
    end
  end

  class BaseService
  end

  class ItemService < BaseService
    include Logging

    def find(id)
      Item.new(id)
    end

    def summary(item)
      item.id
    end
  end

  def self.describe(item)
    service = ItemService.new
    service.summary(item)
  end
end
