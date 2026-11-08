import Combine
import SwiftUI

/// View-local state, equivalent to `@State`.
///
/// Why not `@State`: in the macOS 27 SDK `@State` is an attached macro implemented in the
/// `SwiftUIMacros` compiler plugin, which ships with Xcode but not with the Command Line
/// Tools. This package must build with the CLT only, so view-local state is stored in a
/// `@StateObject` box instead (same lifetime and invalidation semantics for our uses).
@propertyWrapper
public struct ViewState<Value>: DynamicProperty {
    final class Box: ObservableObject {
        @Published var value: Value
        init(_ value: Value) { self.value = value }
    }

    @StateObject private var box: Box

    public init(wrappedValue: Value) {
        _box = StateObject(wrappedValue: Box(wrappedValue))
    }

    public var wrappedValue: Value {
        get { box.value }
        nonmutating set { box.value = newValue }
    }

    public var projectedValue: Binding<Value> { $box.value }
}
